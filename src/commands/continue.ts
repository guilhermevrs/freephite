import { execSync } from "child_process";
import yargs from "yargs";
import { restackBranch, stackFixActionContinuation } from "../actions/fix";
import {
  clearPersistedMergeConflictCallstack,
  getPersistedMergeConflictCallstack,
  MergeConflictCallstackT,
} from "../lib/config/merge_conflict_callstack_config";
import { PreconditionsFailedError } from "../lib/errors";
import { profile } from "../lib/telemetry";
import { rebaseInProgress } from "../lib/utils/rebase_in_progress";
import Branch from "../wrapper-classes/branch";

const args = {
  edit: {
    describe: `Edit the commit message for an amended, resolved merge conflict. By default true; use --no-edit to set this to false.`,
    demandOption: false,
    default: true,
    type: "boolean",
  },
} as const;

type argsT = yargs.Arguments<yargs.InferredOptionTypes<typeof args>>;

export const command = "continue";
export const canonical = "continue";
export const aliases = [];
export const description =
  "Continues the most-recent Graphite command halted by a merge conflict.";
export const builder = args;
export const handler = async (argv: argsT): Promise<void> => {
  return profile(argv, canonical, async () => {
    const mostRecentCheckpoint = getPersistedMergeConflictCallstack();
    if (mostRecentCheckpoint === null) {
      throw new PreconditionsFailedError(`No Graphite command to continue.`);
    }

    if (rebaseInProgress()) {
      execSync(`${argv.edit ? "" : "GIT_EDITOR=true"} git rebase --continue`, {
        stdio: "inherit",
      });
    }

    await resolveCallstack(mostRecentCheckpoint);

    clearPersistedMergeConflictCallstack();
  });
};

async function resolveCallstack(
  callstack: MergeConflictCallstackT
): Promise<void> {
  if (
    callstack === "TOP_OF_CALLSTACK_WITH_NOTHING_AFTER" ||
    callstack === "MERGE_CONFLICT_CALLSTACK_TODO"
  ) {
    return;
  }

  switch (callstack.frame.op) {
    case "STACK_FIX": {
      const branch = await Branch.branchWithName(
        callstack.frame.sourceBranchName
      );
      await restackBranch({
        branch: branch,
        mergeConflictCallstack: callstack.parent,
      });
      break;
    }
    case "STACK_FIX_ACTION_CONTINUATION":
      await stackFixActionContinuation(callstack.frame);
      break;
    default:
      assertUnreachable(callstack.frame);
  }

  await resolveCallstack(callstack.parent);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function assertUnreachable(arg: never): void {}
