import { q } from '../utils/escape_for_shell';
import { gpExecSync } from '../utils/exec_sync';
import { rebaseInProgress } from './rebase_in_progress';

type TRebaseResult = 'REBASE_CONFLICT' | 'REBASE_DONE';
export function restack(args: {
  parentBranchName: string;
  parentBranchRevision: string;
  branchName: string;
}): TRebaseResult {
  gpExecSync({
    command: `git rebase --onto ${q(args.parentBranchName)} ${q(
      args.parentBranchRevision
    )} ${q(args.branchName)}`,
    options: { stdio: 'ignore' },
  });
  return rebaseInProgress() ? 'REBASE_CONFLICT' : 'REBASE_DONE';
}

export function restackContinue(): TRebaseResult {
  gpExecSync({
    command: `GIT_EDITOR=true git rebase --continue`,
    options: { stdio: 'ignore' },
  });
  return rebaseInProgress() ? 'REBASE_CONFLICT' : 'REBASE_DONE';
}

export function rebaseInteractive(args: {
  parentBranchRevision: string;
  branchName: string;
}): TRebaseResult {
  gpExecSync({
    command: `git rebase -i ${q(args.parentBranchRevision)} ${q(
      args.branchName
    )}`,
    options: { stdio: 'inherit' },
  });
  return rebaseInProgress() ? 'REBASE_CONFLICT' : 'REBASE_DONE';
}
