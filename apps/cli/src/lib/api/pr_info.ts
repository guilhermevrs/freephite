import { API_ROUTES } from '@withgraphite/graphite-cli-routes';
import t from '@withgraphite/retype';
import { TUserConfig } from '../spiffy/user_config_spf';
import { TRepoParams } from './common_params';
import { requestWithArgs } from './request';

type TBranchNameWithPrNumber = {
  branchName: string;
  prNumber: number | undefined;
};

export type TPRInfoToUpsert = t.UnwrapSchemaMap<
  typeof API_ROUTES.pullRequestInfo.response
>['prs'];

export async function getPrInfoForBranches(
  branchNamesWithExistingPrInfo: TBranchNameWithPrNumber[],
  params: TRepoParams,
  userConfig: TUserConfig
): Promise<TPRInfoToUpsert> {
  // We sync branches without existing PR info by name.  For branches
  // that are already associated with a PR, we only sync if both the
  // the associated PR (keyed by number) if the name matches the headRef.

  const branchesWithoutPrInfo = new Set<string>();
  const existingPrInfo = new Map<number, string>();

  branchNamesWithExistingPrInfo.forEach((branch) => {
    if (branch?.prNumber === undefined) {
      branchesWithoutPrInfo.add(branch.branchName);
    } else {
      existingPrInfo.set(branch.prNumber, branch.branchName);
    }
  });

  const response = await requestWithArgs(
    userConfig,
    API_ROUTES.pullRequestInfo,
    {
      ...params,
      prNumbers: [...existingPrInfo.keys()],
      prHeadRefNames: [...branchesWithoutPrInfo],
    }
  );

  if (response._response.status !== 200) {
    return [];
  }

  return response.prs.filter((pr) => {
    const branchNameIfAssociated = existingPrInfo.get(pr.prNumber);

    const shouldAssociatePrWithBranch =
      !branchNameIfAssociated &&
      pr.state === 'OPEN' &&
      branchesWithoutPrInfo.has(pr.headRefName);

    const shouldUpdateExistingBranch =
      branchNameIfAssociated === pr.headRefName;

    return shouldAssociatePrWithBranch || shouldUpdateExistingBranch;
  });
}
