import { API_ROUTES } from '@withgraphite/graphite-cli-routes';
import chalk from 'chalk';
import { requestWithArgs } from '../../lib/api/request';
import { TContext } from '../../lib/context';
import { TScopeSpec } from '../../lib/engine/scope_spec';
import { ExitFailedError, KilledError } from '../../lib/errors';
import { CommandFailedError } from '../../lib/git/runner';
import { cliAuthPrecondition } from '../../lib/preconditions';
import { getSurvey, showSurvey } from '../survey';
import { getPRInfoForBranches } from './prepare_branches';
import { submitPullRequest } from './submit_prs';
import { validateBranchesToSubmit } from './validate_branches';
import { Octokit } from '@octokit/core';
import { type PR, StackCommentBody } from './comment_body';

// eslint-disable-next-line max-lines-per-function
export async function submitAction(
  args: {
    scope: TScopeSpec;
    editPRFieldsInline: boolean | undefined;
    draft: boolean;
    publish: boolean;
    dryRun: boolean;
    updateOnly: boolean;
    reviewers: string | undefined;
    confirm: boolean;
    forcePush: boolean;
    select: boolean;
    always: boolean;
    branch: string | undefined;
    mergeWhenReady: boolean;
  },
  context: TContext
): Promise<void> {
  // Check CLI pre-condition to warn early
  if (args.draft && args.publish) {
    throw new ExitFailedError(
      `Can't use both --publish and --draft flags in one command`
    );
  }
  const populateRemoteShasPromise = context.engine.populateRemoteShas();
  const cliAuthToken = cliAuthPrecondition(context);
  if (args.dryRun) {
    context.splog.info(
      chalk.yellow(
        `Running submit in 'dry-run' mode. No branches will be pushed and no PRs will be opened or updated.`
      )
    );
    context.splog.newline();
    args.editPRFieldsInline = false;
  }

  if (!context.interactive) {
    args.editPRFieldsInline = false;
    args.reviewers = undefined;

    context.splog.info(
      `Running in non-interactive mode. Inline prompts to fill PR fields will be skipped${
        !(args.draft || args.publish)
          ? ' and new PRs will be created in draft mode'
          : ''
      }.`
    );
    context.splog.newline();
  }

  const allBranchNames = context.engine
    .getRelativeStack(context.engine.currentBranchPrecondition, args.scope)
    .filter((branchName) => !context.engine.isTrunk(branchName));

  const branchNames = args.select
    ? await selectBranches(context, allBranchNames)
    : allBranchNames;

  context.splog.info(
    chalk.blueBright(
      `🥞 Validating that this Graphite stack is ready to submit...`
    )
  );
  context.splog.newline();
  await validateBranchesToSubmit(branchNames, context);

  context.splog.info(
    chalk.blueBright(
      '✏️  Preparing to submit PRs for the following branches...'
    )
  );
  await populateRemoteShasPromise;
  const submissionInfos = await getPRInfoForBranches(
    {
      branchNames: branchNames,
      editPRFieldsInline: args.editPRFieldsInline && context.interactive,
      draft: args.draft,
      publish: args.publish,
      updateOnly: args.updateOnly,
      reviewers: args.reviewers,
      dryRun: args.dryRun,
      select: args.select,
      always: args.always,
    },
    context
  );

  if (
    await shouldAbort(
      { ...args, hasAnyPrs: submissionInfos.length > 0 },
      context
    )
  ) {
    return;
  }

  context.splog.info(
    chalk.blueBright('📨 Pushing to remote and creating/updating PRs...')
  );

  for (const submissionInfo of submissionInfos) {
    try {
      context.engine.pushBranch(submissionInfo.head, args.forcePush);
    } catch (err) {
      if (
        err instanceof CommandFailedError &&
        err.message.includes('stale info')
      ) {
        throw new ExitFailedError(
          [
            `Force-with-lease push of ${chalk.yellow(
              submissionInfo.head
            )} failed due to external changes to the remote branch.`,
            'If you are collaborating on this stack, try `gt downstack get` to pull in changes.',
            'Alternatively, use the `--force` option of this command to bypass the stale info warning.',
          ].join('\n')
        );
      }
      throw err;
    }

    await submitPullRequest(
      {
        submissionInfo: [submissionInfo],
        mergeWhenReady: args.mergeWhenReady,
        trunkBranchName: context.engine.trunk,
        cliAuthToken,
      },
      context
    );
  }

  const octokit = new Octokit({
    auth: context.userConfig.getFPAuthToken(),
  });

  const prs: Array<PR> = [];
  for (const submissionInfo of submissionInfos) {
    const info = context.engine.getPrInfo(submissionInfo.head);
    if (info?.number && info?.base) {
      prs.push({
        base: info.base,
        number: info.number,
        ref: submissionInfo.head,
      });
    }
  }

  const comment = StackCommentBody.generate(prs);
  const owner = context.repoConfig.getRepoOwner();
  const repo = context.repoConfig.getRepoName();

  for (const pr of prs) {
    const existing = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner,
        repo,
        issue_number: pr.number,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    const update = existing.data.find((comment) =>
      comment.body?.includes('This comment was autogenerated by Freephite.')
    );

    if (update) {
      await octokit.request(
        'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
        {
          owner,
          repo,
          comment_id: update.id,
          body: comment.forPR(pr),
          headers: {
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
    } else {
      await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner,
          repo,
          issue_number: pr.number,
          body: comment.forPR(pr),
          headers: {
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
    }
  }

  await displayRepoMessage(context);

  if (!context.interactive) {
    return;
  }

  const survey = await getSurvey(context);
  if (survey) {
    await showSurvey(survey, context);
  }
}

const IGNORE_MESSAGES = ['Upgrade your plan to keep stacking'];

export async function displayRepoMessage(context: TContext): Promise<void> {
  try {
    cliAuthPrecondition(context);
    const response = await requestWithArgs(
      context.userConfig,
      API_ROUTES.getRepoMessage,
      {},
      {
        org: context.repoConfig.getRepoOwner(),
        repo: context.repoConfig.getRepoName(),
      }
    );

    const { message } = response;
    if (response._response.status !== 200 || !message) {
      return;
    }

    // Don't show the ignored messages to the user
    if (IGNORE_MESSAGES.find((m) => message.text.includes(m))) {
      return;
    }

    switch (message.status) {
      case 'info':
        context.splog.info(message.text);
        break;
      case 'warning':
        context.splog.warn(message.text);
        break;
      case 'error':
        context.splog.error(message.text);
        break;
    }
  } catch (e) {
    // silence any error - this shouldn't crash any part of the CLI
  }
}

async function selectBranches(
  context: TContext,
  branchNames: string[]
): Promise<string[]> {
  const result = [];
  for (const branchName of branchNames) {
    const selected = (
      await context.prompts({
        name: 'value',
        initial: true,
        type: 'confirm',
        message: `Would you like to submit ${chalk.cyan(branchName)}?`,
      })
    ).value;
    // Clear the prompt result
    process.stdout.moveCursor(0, -1);
    process.stdout.clearLine(1);
    if (selected) {
      result.push(branchName);
    }
  }
  return result;
}

async function shouldAbort(
  args: { dryRun: boolean; confirm: boolean; hasAnyPrs: boolean },
  context: TContext
): Promise<boolean> {
  if (args.dryRun) {
    context.splog.info(chalk.blueBright('✅ Dry run complete.'));
    return true;
  }

  if (!args.hasAnyPrs) {
    context.splog.info(chalk.blueBright('🆗 All PRs up to date.'));
    return true;
  }

  if (
    context.interactive &&
    args.confirm &&
    !(
      await context.prompts({
        type: 'confirm',
        name: 'value',
        message: 'Continue with this submit operation?',
        initial: true,
      })
    ).value
  ) {
    context.splog.info(chalk.blueBright('🛑 Aborted submit.'));
    throw new KilledError();
  }

  return false;
}
