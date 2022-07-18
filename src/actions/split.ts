import chalk from 'chalk';
import prompts from 'prompts';
import { GRAPHITE_COLORS } from '../lib/colors';
import { TContext } from '../lib/context';
import { SCOPE } from '../lib/engine/scope_spec';
import { KilledError, PreconditionsFailedError } from '../lib/errors';
import { getUnstagedChanges } from '../lib/git/diff';
import { uncommittedTrackedChangesPrecondition } from '../lib/preconditions';
import { replaceUnsupportedCharacters } from '../lib/utils/branch_name';
import { restackBranches } from './restack';

type TSplit = {
  // list of branch names from oldest to newest
  branchNames: string[];
  // list of commits to branch at keyed by distance from HEAD,
  // i.e. if the branch log shows:
  // C
  // B
  // A
  // and we have [0,2] we would branch at A and C
  branchPoints: number[];
};
export async function splitCurrentBranch(
  args: { style: 'hunk' | 'commit' | undefined },
  context: TContext
): Promise<void> {
  if (!context.interactive) {
    throw new PreconditionsFailedError(
      'This command must be run in interactive mode.'
    );
  }
  uncommittedTrackedChangesPrecondition();

  // If user did not select a style, prompt unless there is only one commit
  const style: 'hunk' | 'commit' | 'abort' =
    args.style ??
    (context.metaCache.getAllCommits(
      context.metaCache.currentBranchPrecondition,
      'SHA'
    ).length > 1
      ? (
          await prompts(
            {
              type: 'select',
              name: 'value',
              message: `How would you like to split ${context.metaCache.currentBranchPrecondition}?`,
              choices: [
                {
                  title: 'By commit - slice up the history of this branch.',
                  value: 'commit',
                },
                {
                  title: 'By hunk - split into new single-commit branches.',
                  value: 'hunk',
                },
                { title: 'Cancel this command (Ctrl+C).', value: 'abort' },
              ],
            },
            {
              onCancel: () => {
                throw new KilledError();
              },
            }
          )
        ).value
      : 'hunk');

  const actions = {
    commit: splitByCommit,
    hunk: splitByHunk,
    abort: () => {
      throw new KilledError();
    },
  };

  const branchToSplit = context.metaCache.currentBranchPrecondition;
  const branchesToRestack = context.metaCache.getRelativeStack(
    branchToSplit,
    SCOPE.UPSTACK_EXCLUSIVE
  );

  const split = await actions[style](branchToSplit, context);

  context.metaCache.applySplitToCommits({
    branchToSplit,
    ...split,
  });

  restackBranches(branchesToRestack, context);
}

async function splitByCommit(
  branchToSplit: string,
  context: TContext
): Promise<TSplit> {
  context.splog.info(
    [
      `Splitting the commits of ${chalk.cyan(
        branchToSplit
      )} into multiple branches.`,
      ...(context.metaCache.getPrInfo(branchToSplit)?.number
        ? [
            `If any of the new branches keeps the name ${chalk.cyan(
              branchToSplit
            )}, it will be linked to #${
              context.metaCache.getPrInfo(branchToSplit)?.number
            }.`,
          ]
        : []),
      ``,
      chalk.yellow(`For each branch you'd like to create:`),
      `1. Choose which commit it begins at using the below prompt.`,
      `2. Choose its name.`,
      ``,
    ].join('\n')
  );

  const readableCommits = context.metaCache.getAllCommits(
    branchToSplit,
    'READABLE'
  );

  const branchPoints = await getBranchPoints(readableCommits);
  const branchNames: string[] = [];
  for (let _ = 0; _ < branchPoints.length; _++) {
    await promptNextBranchName({ branchNames, branchToSplit }, context);
    context.splog.newline();
  }

  context.metaCache.detach();
  return { branchNames, branchPoints };
}

async function getBranchPoints(readableCommits: string[]): Promise<number[]> {
  // Array where nth index is whether we want a branch pointing to nth commit
  const isBranchPoint: boolean[] = readableCommits.map((_, idx) => idx === 0);

  let lastValue = 0;
  // -1 signifies that we are done
  while (lastValue !== -1) {
    // Never toggle the first commmit, it always needs a branch
    if (lastValue !== 0) {
      isBranchPoint[lastValue] = !isBranchPoint[lastValue];
    }
    // We count branches in reverse so start at the total number of branch points
    let branchNumber = Object.values(isBranchPoint).filter((v) => v).length + 1;
    lastValue = parseInt(
      (
        await prompts(
          {
            type: 'select',
            name: 'value',
            message: `Toggle a commit to split the branch there.`,
            hint: 'Arrow keys and return/space. Select confirm to finish.',
            initial: lastValue,
            choices: readableCommits
              .map((commit, index) => {
                const shouldDisplayBranchNumber = isBranchPoint[index];
                if (shouldDisplayBranchNumber) {
                  branchNumber--;
                }
                return {
                  title: chalk.rgb(
                    ...GRAPHITE_COLORS[
                      (branchNumber - 1) % GRAPHITE_COLORS.length
                    ]
                  )(
                    `${
                      shouldDisplayBranchNumber ? `${branchNumber}. ` : '   '
                    }${commit}`
                  ),
                  value: '' + index,
                };
              })
              .concat([{ title: '   Confirm', value: '-1' }]),
          },
          {
            onCancel: () => {
              throw new KilledError();
            },
          }
        )
      ).value
    );
    // Clear the prompt result
    process.stdout.moveCursor(0, -1);
    process.stdout.clearLine(1);
  }

  return isBranchPoint
    .map((value, index) => (value ? index : undefined))
    .filter((value): value is number => typeof value !== 'undefined');
}

async function splitByHunk(
  branchToSplit: string,
  context: TContext
): Promise<TSplit> {
  const defaultCommitMessage = context.metaCache
    .getAllCommits(branchToSplit, 'MESSAGE')
    .reverse()
    .join('\n\n');

  context.metaCache.detachAndResetBranchChanges();

  const instructions = [
    `Splitting ${chalk.cyan(
      branchToSplit
    )} into multiple single-commit branches.`,
    ...(context.metaCache.getPrInfo(branchToSplit)?.number
      ? [
          `If any of the new branches keeps the name ${chalk.cyan(
            branchToSplit
          )}, it will be linked to #${
            context.metaCache.getPrInfo(branchToSplit)?.number
          }.`,
        ]
      : []),
    ``,
    chalk.yellow(`For each branch you'd like to create:`),
    `1. Follow the prompts to stage the changes that you'd like to include.`,
    `2. Enter a commit message.`,
    `3. Pick a branch name.`,
    `The command will continue until all changes have been added to a new branch.`,
  ].join('\n');

  const branchNames: string[] = [];
  try {
    for (
      let unstagedChanges = getUnstagedChanges();
      unstagedChanges.length > 0;
      unstagedChanges = getUnstagedChanges()
    ) {
      context.splog.info(instructions);
      context.splog.newline();
      context.splog.info(chalk.yellow('Remaining changes:'));
      context.splog.info(' ' + unstagedChanges);
      context.splog.newline();
      context.metaCache.commit({
        message: defaultCommitMessage,
        edit: true,
        patch: true,
      });
      await promptNextBranchName({ branchNames, branchToSplit }, context);
      context.splog.newline();
    }
  } catch (e) {
    // Handle a CTRL-C gracefully
    context.metaCache.forceCheckoutBranch(branchToSplit);
    context.splog.newline();
    context.splog.info(
      `Exited early: no new branches created. You are still on ${chalk.cyan(
        branchToSplit
      )}.`
    );
    throw e;
  }

  return {
    branchNames,
    // for single-commit branches, there is a branch point at each commit
    branchPoints: branchNames.map((_, idx) => idx),
  };
}
async function promptNextBranchName(
  {
    branchToSplit,
    branchNames,
  }: {
    branchToSplit: string;
    branchNames: string[];
  },
  context: TContext
) {
  const { branchName } = await prompts(
    {
      type: 'text',
      name: 'branchName',
      message: `${branchNames.length + 1}. Branch name`,
      initial: getInitialNextBranchName(branchToSplit, branchNames),
      validate: (name) => {
        const calculatedName = replaceUnsupportedCharacters(name, context);
        return branchNames.includes(calculatedName) ||
          (calculatedName !== branchToSplit &&
            context.metaCache.allBranchNames.includes(calculatedName))
          ? 'Branch name is unavailable.'
          : true;
      },
    },
    {
      onCancel: () => {
        throw new KilledError();
      },
    }
  );
  branchNames.push(branchName);
}

function getInitialNextBranchName(
  originalBranchName: string,
  branchNames: string[]
): string {
  return branchNames.includes(originalBranchName)
    ? getInitialNextBranchName(`${originalBranchName}_split`, branchNames)
    : originalBranchName;
}