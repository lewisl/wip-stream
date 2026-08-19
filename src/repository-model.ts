import { CONFIG_KEYS, CONFIG_VERSION, REPOSITORY_CONFIG_VERSION } from "./constants";
import { BranchRelation as GitBranchRelation, GitRef, GitRepository } from "./git";

const LEGACY_DEFAULTS = {
  remote: "origin",
  mainBranch: "main",
  featureBranch: "feature",
  wipBranch: "wip/feature",
} as const;

export const INTERNAL_REF_PREFIX = "refs/wipstream/";

export class RepositoryModelError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepositoryModelError";
    this.code = code;
  }
}

export interface UninitializedRepositoryConfiguration {
  readonly kind: "uninitialized";
}

export interface Version1RepositoryConfiguration {
  readonly kind: "version1";
  readonly version: typeof CONFIG_VERSION;
  readonly remote: string;
  readonly mainBranch: string;
  readonly featureBranch: string;
  readonly wipBranch: string;
  readonly lastKnownRemoteWip?: string;
}

export interface RepositoryConfiguration {
  readonly kind: "version2";
  readonly version: typeof REPOSITORY_CONFIG_VERSION;
  readonly remote: string;
}

export type ReadRepositoryConfiguration =
  | UninitializedRepositoryConfiguration
  | Version1RepositoryConfiguration
  | RepositoryConfiguration;

export type BranchInventoryRelation =
  | "equal"
  | "local-ahead"
  | "local-only"
  | "remote-ahead"
  | "remote-only"
  | "diverged"
  | "remotely-deleted";

export type RemoteTipChange = "unseen" | "created" | "unchanged" | "advanced" | "rewritten" | "deleted";
export type TrackingState = "none" | "selected-remote" | "other-remote";

export interface BranchInventoryEntry {
  readonly name: string;
  readonly localTip?: string;
  readonly previousRemoteTip?: string;
  readonly fetchedRemoteTip?: string;
  readonly upstream?: string;
  readonly tracking: TrackingState;
  readonly checkedOut: boolean;
  readonly relation: BranchInventoryRelation;
  readonly remoteChange: RemoteTipChange;
}

export interface RepositoryInspection {
  readonly configuration: Version1RepositoryConfiguration | RepositoryConfiguration;
  readonly remoteDefaultBranch: string;
  readonly branches: readonly BranchInventoryEntry[];
}

function fail(code: string, message: string): never {
  throw new RepositoryModelError(code, message);
}

function branchParentKey(branch: string): string {
  return `branch.${branch}.wipstreamParent`;
}

async function configOrDefault(repo: GitRepository, key: string, fallback: string): Promise<string> {
  return (await repo.getConfig(key)) || fallback;
}

export async function readRepositoryConfiguration(repo: GitRepository): Promise<ReadRepositoryConfiguration> {
  const version = await repo.getConfig(CONFIG_KEYS.version);
  if (!version) {
    return { kind: "uninitialized" };
  }
  if (version === CONFIG_VERSION) {
    const lastKnownRemoteWip = await repo.getConfig(CONFIG_KEYS.lastKnownRemoteWip);
    return {
      kind: "version1",
      version: CONFIG_VERSION,
      remote: await configOrDefault(repo, CONFIG_KEYS.remote, LEGACY_DEFAULTS.remote),
      mainBranch: await configOrDefault(repo, CONFIG_KEYS.mainBranch, LEGACY_DEFAULTS.mainBranch),
      featureBranch: await configOrDefault(repo, CONFIG_KEYS.featureBranch, LEGACY_DEFAULTS.featureBranch),
      wipBranch: await configOrDefault(repo, CONFIG_KEYS.wipBranch, LEGACY_DEFAULTS.wipBranch),
      ...(lastKnownRemoteWip ? { lastKnownRemoteWip } : {}),
    };
  }
  if (version === REPOSITORY_CONFIG_VERSION) {
    const remote = await repo.getConfig(CONFIG_KEYS.remote);
    if (!remote) {
      fail("INVALID_REPOSITORY_CONFIG", "WipStream version 2 configuration does not name a remote.");
    }
    return { kind: "version2", version: REPOSITORY_CONFIG_VERSION, remote };
  }
  return fail(
    "UNSUPPORTED_CONFIG_VERSION",
    `This repository uses unsupported WipStream configuration version “${version}”.`
  );
}

export async function writeRepositoryConfiguration(
  repo: GitRepository,
  configuration: Pick<RepositoryConfiguration, "remote">
): Promise<void> {
  const remote = configuration.remote.trim();
  if (!remote) {
    fail("INVALID_REPOSITORY_CONFIG", "WipStream requires a selected remote.");
  }
  await repo.setConfig(CONFIG_KEYS.remote, remote);
  await repo.setConfig(CONFIG_KEYS.version, REPOSITORY_CONFIG_VERSION);
}

export async function getBranchParent(repo: GitRepository, branch: string): Promise<string | undefined> {
  return repo.getConfig(branchParentKey(branch));
}

export async function setBranchParent(repo: GitRepository, branch: string, parent: string): Promise<void> {
  if (!(await repo.validateBranchName(branch)) || !(await repo.validateBranchName(parent)) || branch === parent) {
    fail("INVALID_PARENT_INTENT", "A branch parent must name a different valid Git branch.");
  }
  await repo.setConfig(branchParentKey(branch), parent);
}

function refsByBranch(refs: readonly GitRef[], prefix: string): ReadonlyMap<string, GitRef> {
  const result = new Map<string, GitRef>();
  for (const ref of refs) {
    if (!ref.name.startsWith(prefix) || ref.name.startsWith(INTERNAL_REF_PREFIX)) {
      continue;
    }
    const branch = ref.name.slice(prefix.length);
    if (branch && branch !== "HEAD") {
      result.set(branch, ref);
    }
  }
  return result;
}

export async function snapshotRemoteTips(repo: GitRepository, remote: string): Promise<ReadonlyMap<string, string>> {
  const prefix = `refs/remotes/${remote}/`;
  const refs = refsByBranch(await repo.listRefs(prefix), prefix);
  return new Map([...refs].map(([branch, ref]) => [branch, ref.objectId]));
}

function inventoryRelation(
  relation: GitBranchRelation | undefined,
  localTip: string | undefined,
  fetchedRemoteTip: string | undefined,
  previousRemoteTip: string | undefined
): BranchInventoryRelation {
  if (!fetchedRemoteTip) {
    return previousRemoteTip ? "remotely-deleted" : "local-only";
  }
  if (!localTip) {
    return "remote-only";
  }
  switch (relation) {
    case "equal":
      return "equal";
    case "ahead":
      return "local-ahead";
    case "behind":
      return "remote-ahead";
    case "diverged":
      return "diverged";
    default:
      return fail("INVALID_BRANCH_INVENTORY", "WipStream could not classify an ordinary branch.");
  }
}

async function remoteTipChange(
  repo: GitRepository,
  previousRemoteTip: string | undefined,
  fetchedRemoteTip: string | undefined
): Promise<RemoteTipChange> {
  if (!previousRemoteTip) {
    return fetchedRemoteTip ? "created" : "unseen";
  }
  if (!fetchedRemoteTip) {
    return "deleted";
  }
  if (previousRemoteTip === fetchedRemoteTip) {
    return "unchanged";
  }
  return (await repo.isAncestor(previousRemoteTip, fetchedRemoteTip)) ? "advanced" : "rewritten";
}

export async function inspectBranchInventory(
  repo: GitRepository,
  remote: string,
  previousRemoteTips: ReadonlyMap<string, string> = new Map()
): Promise<readonly BranchInventoryEntry[]> {
  const localPrefix = "refs/heads/";
  const remotePrefix = `refs/remotes/${remote}/`;
  const localRefs = refsByBranch(await repo.listRefs(localPrefix), localPrefix);
  const remoteRefs = refsByBranch(await repo.listRefs(remotePrefix), remotePrefix);
  const currentBranch = await repo.currentBranch();
  const names = [...new Set([...localRefs.keys(), ...remoteRefs.keys(), ...previousRemoteTips.keys()])].sort();
  const result: BranchInventoryEntry[] = [];

  for (const name of names) {
    const local = localRefs.get(name);
    const fetchedRemote = remoteRefs.get(name);
    const previousRemoteTip = previousRemoteTips.get(name);
    const relation = local && fetchedRemote
      ? await repo.relation(local.name, fetchedRemote.name)
      : undefined;
    const expectedUpstream = `${remote}/${name}`;
    result.push({
      name,
      localTip: local?.objectId,
      previousRemoteTip,
      fetchedRemoteTip: fetchedRemote?.objectId,
      upstream: local?.upstream,
      tracking: !local?.upstream
        ? "none"
        : local.upstream === expectedUpstream
          ? "selected-remote"
          : "other-remote",
      checkedOut: currentBranch === name,
      relation: inventoryRelation(relation, local?.objectId, fetchedRemote?.objectId, previousRemoteTip),
      remoteChange: await remoteTipChange(repo, previousRemoteTip, fetchedRemote?.objectId),
    });
  }

  return result;
}

export async function resolveRemoteDefaultBranch(repo: GitRepository, remote: string): Promise<string> {
  const symbolicHead = `refs/remotes/${remote}/HEAD`;
  const target = await repo.symbolicRef(symbolicHead);
  if (!target) {
    return fail(
      "REMOTE_HEAD_MISSING",
      `Remote “${remote}” does not identify a default branch. Fetch it and set its symbolic HEAD before retrying.`
    );
  }

  const prefix = `refs/remotes/${remote}/`;
  const branch = target.startsWith(prefix) ? target.slice(prefix.length) : undefined;
  if (!branch || branch === "HEAD" || !(await repo.refExists(target))) {
    return fail(
      "REMOTE_HEAD_AMBIGUOUS",
      `Remote “${remote}” has an invalid or ambiguous symbolic HEAD. Set one existing remote branch as its default.`
    );
  }
  return branch;
}

export async function inspectRepository(
  repo: GitRepository,
  previousRemoteTips: ReadonlyMap<string, string> = new Map()
): Promise<RepositoryInspection> {
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind === "uninitialized") {
    return fail("NOT_INITIALIZED", "Initialize this repository before inspecting its WipStream branch model.");
  }
  return {
    configuration,
    remoteDefaultBranch: await resolveRemoteDefaultBranch(repo, configuration.remote),
    branches: await inspectBranchInventory(repo, configuration.remote, previousRemoteTips),
  };
}
