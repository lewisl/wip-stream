import { CONFIG_KEYS, CONFIG_VERSION } from "./constants";
import { BranchRelation, GitError, GitRepository } from "./git";
import { withRepositoryCommandLock } from "./repository-safety";

export interface StreamConfig {
  readonly remote: string;
  readonly mainBranch: string;
  readonly featureBranch: string;
  readonly wipBranch: string;
}

export interface StreamConfigInput {
  readonly remote?: string;
  readonly mainBranch?: string;
  readonly featureBranch?: string;
  readonly wipBranch?: string;
}

export interface SyncResult {
  readonly checkpointCreated: boolean;
  readonly published: boolean;
  readonly wipHistoryRewritten?: boolean;
  readonly failure?: "offline" | "remote-changed";
}

type CheckpointMessageProvider = (defaultMessage: string) => Promise<string>;
export interface WipRewriteConfirmation {
  readonly unverifiedBase: boolean;
}
type WipRewriteConfirmationProvider = (confirmation: WipRewriteConfirmation) => Promise<boolean>;

export type InitializeResult = "created" | "attached" | "current";
export type ResumeResult = "resumed" | "current" | "completed";
export type FinishResult = "finished" | "already-finished";

export class WorkflowError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

const DEFAULT_CONFIG: StreamConfig = {
  remote: "origin",
  mainBranch: "main",
  featureBranch: "feature",
  wipBranch: "wip/feature",
};

interface ManagedBranch {
  readonly name: string;
  readonly remoteRef: string;
}

interface BranchState extends ManagedBranch {
  readonly exists: boolean;
  readonly relation?: BranchRelation;
}

interface WipRewritePlan {
  readonly expectedRemoteWip: string;
  readonly unverifiedBase: boolean;
}

function fail(code: string, message: string): never {
  throw new WorkflowError(code, message);
}

function valuesAreDistinct(config: StreamConfig): boolean {
  return new Set([config.mainBranch, config.featureBranch, config.wipBranch]).size === 3;
}

function refspec(branch: string): string {
  return `${branch}:${branch}`;
}

function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(could not resolve host|failed to connect|network is unreachable|no route to host|connection timed out|connection reset|could not read from remote)/i.test(
    message
  );
}

function checkpointMessage(): string {
  return `WIP checkpoint ${new Date().toISOString()}`;
}

export async function defaultsFor(repo: GitRepository): Promise<StreamConfig> {
  return {
    remote: (await repo.getConfig(CONFIG_KEYS.remote)) || DEFAULT_CONFIG.remote,
    mainBranch: (await repo.getConfig(CONFIG_KEYS.mainBranch)) || DEFAULT_CONFIG.mainBranch,
    featureBranch: (await repo.getConfig(CONFIG_KEYS.featureBranch)) || DEFAULT_CONFIG.featureBranch,
    wipBranch: (await repo.getConfig(CONFIG_KEYS.wipBranch)) || DEFAULT_CONFIG.wipBranch,
  };
}

export async function getStreamConfig(repo: GitRepository): Promise<StreamConfig> {
  if ((await repo.getConfig(CONFIG_KEYS.version)) !== CONFIG_VERSION) {
    fail("NOT_INITIALIZED", "This repository has not been initialized for WipStream. Run WipStream: Initialize Stream.");
  }
  return defaultsFor(repo);
}

async function saveConfig(repo: GitRepository, config: StreamConfig): Promise<void> {
  await repo.setConfig(CONFIG_KEYS.version, CONFIG_VERSION);
  await repo.setConfig(CONFIG_KEYS.remote, config.remote);
  await repo.setConfig(CONFIG_KEYS.mainBranch, config.mainBranch);
  await repo.setConfig(CONFIG_KEYS.featureBranch, config.featureBranch);
  await repo.setConfig(CONFIG_KEYS.wipBranch, config.wipBranch);
}

async function resolveConfig(repo: GitRepository, input: StreamConfigInput): Promise<StreamConfig> {
  const defaults = await defaultsFor(repo);
  const config: StreamConfig = {
    remote: input.remote || defaults.remote,
    mainBranch: input.mainBranch || defaults.mainBranch,
    featureBranch: input.featureBranch || defaults.featureBranch,
    wipBranch: input.wipBranch || defaults.wipBranch,
  };

  if (!valuesAreDistinct(config)) {
    fail("INVALID_BRANCH_NAMES", "The main, feature, and WIP branch names must be different.");
  }

  for (const branch of [config.mainBranch, config.featureBranch, config.wipBranch]) {
    if (!(await repo.validateBranchName(branch))) {
      fail("INVALID_BRANCH_NAME", `“${branch}” is not a valid Git branch name.`);
    }
  }

  return config;
}

function branches(repo: GitRepository, config: StreamConfig): ManagedBranch[] {
  return [config.mainBranch, config.featureBranch, config.wipBranch].map((name) => ({
    name,
    remoteRef: repo.remoteRef(config.remote, name),
  }));
}

async function requireStableRepository(repo: GitRepository, requireClean: boolean): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "WipStream requires a normal Git working repository, not a bare repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "WipStream requires a complete clone, not a shallow clone.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active merge, rebase, cherry-pick, or revert before using WipStream.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before using WipStream.");
  }
  if (requireClean && (await repo.statusPorcelain())) {
    fail("DIRTY_WORKTREE", "This command requires a clean Git working tree.");
  }
}

async function validateRemote(repo: GitRepository, config: StreamConfig): Promise<void> {
  try {
    await repo.ensureRemote(config.remote);
  } catch (error) {
    if (error instanceof GitError) {
      fail("REMOTE_MISSING", `The configured remote “${config.remote}” does not exist.`);
    }
    throw error;
  }
}

async function ensureRemoteMain(repo: GitRepository, config: StreamConfig): Promise<void> {
  if (!(await repo.refExists(repo.remoteRef(config.remote, config.mainBranch)))) {
    fail("REMOTE_MAIN_MISSING", `The remote branch “${config.remote}/${config.mainBranch}” does not exist.`);
  }
}

async function inspectBranchStates(repo: GitRepository, config: StreamConfig): Promise<BranchState[]> {
  const result: BranchState[] = [];
  for (const branch of branches(repo, config)) {
    const exists = await repo.branchExists(branch.name);
    result.push({
      ...branch,
      exists,
      relation: exists ? await repo.relation(repo.localRef(branch.name), branch.remoteRef) : undefined,
    });
  }
  return result;
}

async function assertStatesSafe(states: readonly BranchState[]): Promise<void> {
  for (const state of states) {
    if (state.relation === "ahead") {
      fail("LOCAL_AHEAD", `Local “${state.name}” contains commits that are not on the remote. Preserve or publish them before resuming.`);
    }
    if (state.relation === "diverged") {
      fail("LOCAL_DIVERGED", `Local “${state.name}” and its remote branch have diverged. Manual recovery is required.`);
    }
  }
}

async function applySafeStates(
  repo: GitRepository,
  states: readonly BranchState[],
  detachFirst: boolean
): Promise<boolean> {
  const needsUpdate = states.some((state) => !state.exists || state.relation === "behind");
  if (!needsUpdate) {
    return false;
  }

  if (detachFirst && (await repo.currentBranch())) {
    await repo.detach();
  }

  for (const state of states) {
    if (!state.exists) {
      await repo.createTrackingBranch(state.name, state.remoteRef);
    } else if (state.relation === "behind") {
      await repo.moveBranch(state.name, state.remoteRef);
    }
  }

  return true;
}

async function assertTopology(repo: GitRepository, main: string, feature: string, wip: string): Promise<void> {
  if (!(await repo.isAncestor(main, feature)) || !(await repo.isAncestor(feature, wip))) {
    fail("INVALID_TOPOLOGY", "The WipStream branches must have ancestry main → feature → wip/feature.");
  }
}

async function assertRemoteTopology(repo: GitRepository, config: StreamConfig): Promise<void> {
  await assertTopology(
    repo,
    repo.remoteRef(config.remote, config.mainBranch),
    repo.remoteRef(config.remote, config.featureBranch),
    repo.remoteRef(config.remote, config.wipBranch)
  );
}

async function assertLocalTopology(repo: GitRepository, config: StreamConfig): Promise<void> {
  for (const branch of [config.mainBranch, config.featureBranch, config.wipBranch]) {
    if (!(await repo.branchExists(branch))) {
      fail("LOCAL_BRANCH_MISSING", `Local branch “${branch}” is missing. Run WipStream: Get Current from Remote.`);
    }
  }
  await assertTopology(repo, config.mainBranch, config.featureBranch, config.wipBranch);
}

async function rememberRemoteWip(repo: GitRepository, config: StreamConfig): Promise<void> {
  await repo.setConfig(CONFIG_KEYS.lastKnownRemoteWip, await repo.hash(repo.remoteRef(config.remote, config.wipBranch)));
}

async function prepareWipRewrite(repo: GitRepository, config: StreamConfig): Promise<WipRewritePlan | undefined> {
  const remoteWip = repo.remoteRef(config.remote, config.wipBranch);
  if ((await repo.relation(repo.localRef(config.wipBranch), remoteWip)) !== "diverged") {
    return undefined;
  }

  await repo.fetch(config.remote);
  if (!(await repo.refExists(remoteWip))) {
    fail("PARTIAL_REMOTE_STREAM", "The remote WipStream is incomplete. Inspect and repair it manually.");
  }

  const remoteWipHash = await repo.hash(remoteWip);
  const lastKnownRemoteWip = await repo.getConfig(CONFIG_KEYS.lastKnownRemoteWip);
  if (lastKnownRemoteWip && lastKnownRemoteWip !== remoteWipHash) {
    fail(
      "REMOTE_WIP_CHANGED",
      "The remote WIP stream changed after this machine’s last successful handoff. Do not replace it; recover the local rewrite before continuing."
    );
  }

  return { expectedRemoteWip: remoteWipHash, unverifiedBase: !lastKnownRemoteWip };
}

export async function initialize(repo: GitRepository, input: StreamConfigInput = {}): Promise<InitializeResult> {
  return withRepositoryCommandLock(repo, "Initialize Repository", () => initializeUnlocked(repo, input));
}

async function initializeUnlocked(repo: GitRepository, input: StreamConfigInput = {}): Promise<InitializeResult> {
  await requireStableRepository(repo, true);
  const config = await resolveConfig(repo, input);
  await validateRemote(repo, config);
  await repo.fetch(config.remote);
  await ensureRemoteMain(repo, config);

  const remoteMain = repo.remoteRef(config.remote, config.mainBranch);
  const localMainExists = await repo.branchExists(config.mainBranch);
  if (localMainExists) {
    const mainRelation = await repo.relation(repo.localRef(config.mainBranch), remoteMain);
    if (mainRelation === "ahead") {
      fail("LOCAL_MAIN_AHEAD", `Local “${config.mainBranch}” contains unpushed commits.`);
    }
    if (mainRelation === "diverged") {
      fail("LOCAL_MAIN_DIVERGED", `Local “${config.mainBranch}” has diverged from the remote.`);
    }
    if (mainRelation === "behind") {
      if ((await repo.currentBranch()) === config.mainBranch) {
        await repo.fastForward(remoteMain);
      } else {
        await repo.moveBranch(config.mainBranch, remoteMain);
      }
    }
  } else {
    await repo.createTrackingBranch(config.mainBranch, remoteMain);
  }

  await repo.verifyAtomicPush(config.remote, config.mainBranch);

  const remoteFeature = repo.remoteRef(config.remote, config.featureBranch);
  const remoteWip = repo.remoteRef(config.remote, config.wipBranch);
  const featureExists = await repo.refExists(remoteFeature);
  const wipExists = await repo.refExists(remoteWip);

  if (featureExists !== wipExists) {
    fail("PARTIAL_REMOTE_STREAM", "Exactly one temporary WipStream branch exists on the remote. Inspect and repair it manually.");
  }

  if (!featureExists) {
    const localFeature = await repo.branchExists(config.featureBranch);
    const localWip = await repo.branchExists(config.wipBranch);
    if (localFeature !== localWip) {
      fail("PARTIAL_LOCAL_STREAM", "Exactly one local temporary WipStream branch exists. Inspect it before initializing.");
    }

    if (localFeature && localWip) {
      const mainHash = await repo.hash(config.mainBranch);
      const featureHash = await repo.hash(config.featureBranch);
      const wipHash = await repo.hash(config.wipBranch);
      if (featureHash !== mainHash || wipHash !== mainHash) {
        if (!(await repo.isAncestor(config.featureBranch, config.mainBranch)) || !(await repo.isAncestor(config.wipBranch, config.mainBranch))) {
          fail("CONFLICTING_LOCAL_STREAM", "Local temporary branches do not both point to main or completed main history and cannot be reused safely.");
        }
        await repo.detach();
        await repo.deleteLocalBranch(config.featureBranch);
        await repo.deleteLocalBranch(config.wipBranch);
        await repo.createBranch(config.featureBranch, config.mainBranch);
        await repo.createBranch(config.wipBranch, config.featureBranch);
      }
    } else {
      await repo.createBranch(config.featureBranch, config.mainBranch);
      await repo.createBranch(config.wipBranch, config.featureBranch);
    }

    try {
      await repo.pushAtomic(config.remote, [refspec(config.featureBranch), refspec(config.wipBranch)]);
    } catch (error) {
      if (error instanceof GitError) {
        fail("STREAM_NOT_PUBLISHED", "The local stream was created, but the remote branches were not published atomically. Fix the remote problem and run Initialize again.");
      }
      throw error;
    }
    await repo.setUpstream(config.featureBranch, `${config.remote}/${config.featureBranch}`);
    await repo.setUpstream(config.wipBranch, `${config.remote}/${config.wipBranch}`);
    await saveConfig(repo, config);
    await resumeUnlocked(repo);
    return "created";
  }

  await assertRemoteTopology(repo, config);
  const states = await inspectBranchStates(repo, config);
  await assertStatesSafe(states);
  const branchBeforeUpdate = await repo.currentBranch();
  const changed = await applySafeStates(repo, states, true);
  if (changed && branchBeforeUpdate) {
    await repo.switch(branchBeforeUpdate);
  }
  await saveConfig(repo, config);
  await resumeUnlocked(repo);
  return changed ? "attached" : "current";
}

export async function resume(repo: GitRepository): Promise<ResumeResult> {
  return withRepositoryCommandLock(repo, "Get from Remote", () => resumeUnlocked(repo));
}

async function resumeUnlocked(repo: GitRepository): Promise<ResumeResult> {
  const config = await getStreamConfig(repo);
  await requireStableRepository(repo, true);
  await validateRemote(repo, config);
  await repo.fetch(config.remote);
  await ensureRemoteMain(repo, config);

  const remoteFeature = repo.remoteRef(config.remote, config.featureBranch);
  const remoteWip = repo.remoteRef(config.remote, config.wipBranch);
  const featureExists = await repo.refExists(remoteFeature);
  const wipExists = await repo.refExists(remoteWip);
  if (!featureExists && !wipExists) {
    const remoteMain = repo.remoteRef(config.remote, config.mainBranch);
    const localMainExists = await repo.branchExists(config.mainBranch);
    const mainRelation = localMainExists
      ? await repo.relation(repo.localRef(config.mainBranch), remoteMain)
      : undefined;
    if (mainRelation === "ahead") {
      fail("LOCAL_MAIN_AHEAD", `Local “${config.mainBranch}” contains commits that are not on the completed remote main.`);
    }
    if (mainRelation === "diverged") {
      fail("LOCAL_MAIN_DIVERGED", `Local “${config.mainBranch}” has diverged from the completed remote main.`);
    }

    for (const branch of [config.featureBranch, config.wipBranch]) {
      if ((await repo.branchExists(branch)) && !(await repo.isAncestor(branch, remoteMain))) {
        fail("LOCAL_UNFINISHED_WORK", `Local “${branch}” contains work that is not in remote main. Preserve it before resuming.`);
      }
    }

    await repo.detach();
    if (!localMainExists) {
      await repo.createTrackingBranch(config.mainBranch, remoteMain);
    } else if (mainRelation === "behind") {
      await repo.moveBranch(config.mainBranch, remoteMain);
    }
    await repo.deleteLocalBranch(config.featureBranch);
    await repo.deleteLocalBranch(config.wipBranch);
    await repo.switch(config.mainBranch);
    return "completed";
  }
  if (!featureExists || !wipExists) {
    fail("PARTIAL_REMOTE_STREAM", "The remote WipStream is incomplete. Inspect and repair it manually.");
  }

  await assertRemoteTopology(repo, config);
  const states = await inspectBranchStates(repo, config);
  await assertStatesSafe(states);
  const changed = await applySafeStates(repo, states, true);
  await repo.switch(config.wipBranch);
  await rememberRemoteWip(repo, config);
  return changed ? "resumed" : "current";
}

async function validateSaveUpState(repo: GitRepository, config: StreamConfig): Promise<void> {
  await requireStableRepository(repo, false);
  if (await repo.hasDirtySubmodules()) {
    fail("DIRTY_SUBMODULES", "Commit or discard changes inside submodules before using Save to Remote.");
  }
  if ((await repo.currentBranch()) !== config.wipBranch) {
    fail("WRONG_BRANCH", `Save to Remote requires “${config.wipBranch}” to be checked out. Run WipStream: Get Current from Remote first.`);
  }
  await assertLocalTopology(repo, config);
}

export async function saveUp(
  repo: GitRepository,
  requestCheckpointMessage?: CheckpointMessageProvider,
  confirmWipRewrite?: WipRewriteConfirmationProvider
): Promise<SyncResult> {
  return withRepositoryCommandLock(repo, "Commit and Save", () =>
    saveUpUnlocked(repo, requestCheckpointMessage, confirmWipRewrite)
  );
}

async function saveUpUnlocked(
  repo: GitRepository,
  requestCheckpointMessage?: CheckpointMessageProvider,
  confirmWipRewrite?: WipRewriteConfirmationProvider
): Promise<SyncResult> {
  const config = await getStreamConfig(repo);
  await validateSaveUpState(repo, config);

  let message: string | undefined;
  if ((await repo.statusPorcelain()).trim()) {
    const defaultMessage = checkpointMessage();
    message = requestCheckpointMessage ? await requestCheckpointMessage(defaultMessage) : defaultMessage;
  }
  await repo.stageAll();

  const checkpointCreated = await repo.hasStagedChanges();
  if (checkpointCreated) {
    await repo.commit(message ?? checkpointMessage());
  }

  try {
    const wipRewrite = await prepareWipRewrite(repo, config);
    if (wipRewrite) {
      if (!confirmWipRewrite) {
        fail("WIP_REWRITE_CONFIRMATION_REQUIRED", "WipStream needs confirmation before replacing rewritten remote WIP checkpoints.");
      }
      if (!(await confirmWipRewrite({ unverifiedBase: wipRewrite.unverifiedBase }))) {
        fail("CANCELLED", "WipStream did not replace the remote WIP checkpoints.");
      }
    }
    await repo.pushAtomic(config.remote, [
      refspec(config.mainBranch),
      refspec(config.featureBranch),
      refspec(config.wipBranch),
    ], wipRewrite ? { [config.wipBranch]: wipRewrite.expectedRemoteWip } : {});
    await rememberRemoteWip(repo, config);
    return wipRewrite
      ? { checkpointCreated, published: true, wipHistoryRewritten: true }
      : { checkpointCreated, published: true };
  } catch (error) {
    if (error instanceof GitError) {
      return {
        checkpointCreated,
        published: false,
        failure: isNetworkFailure(error) ? "offline" : "remote-changed",
      };
    }
    throw error;
  }
}

export async function toFeature(repo: GitRepository): Promise<boolean> {
  return withRepositoryCommandLock(repo, "To Feature", () => toFeatureUnlocked(repo));
}

async function toFeatureUnlocked(repo: GitRepository): Promise<boolean> {
  const config = await getStreamConfig(repo);
  await validateSaveUpState(repo, config);
  if (!(await repo.isAncestor(config.featureBranch, config.wipBranch))) {
    fail("INVALID_TOPOLOGY", `“${config.featureBranch}” must be an ancestor of “${config.wipBranch}”.`);
  }

  const alreadyAccepted = (await repo.hash(config.featureBranch)) === (await repo.hash(config.wipBranch));
  if (!alreadyAccepted) {
    await repo.moveBranch(config.featureBranch, config.wipBranch);
  }

  await repo.pushAtomic(config.remote, [
    refspec(config.mainBranch),
    refspec(config.featureBranch),
    refspec(config.wipBranch),
  ]);
  return !alreadyAccepted;
}

async function cleanupLocalTemporaryBranches(repo: GitRepository, config: StreamConfig): Promise<void> {
  await repo.switch(config.mainBranch);
  await repo.deleteLocalBranch(config.featureBranch);
  await repo.deleteLocalBranch(config.wipBranch);
}

export async function toMain(repo: GitRepository): Promise<FinishResult> {
  return withRepositoryCommandLock(repo, "To Main", () => toMainUnlocked(repo));
}

async function toMainUnlocked(repo: GitRepository): Promise<FinishResult> {
  const config = await getStreamConfig(repo);
  await requireStableRepository(repo, true);
  await validateRemote(repo, config);
  await repo.fetch(config.remote);
  await ensureRemoteMain(repo, config);

  const remoteMain = repo.remoteRef(config.remote, config.mainBranch);
  const remoteFeature = repo.remoteRef(config.remote, config.featureBranch);
  const remoteWip = repo.remoteRef(config.remote, config.wipBranch);
  const featureOnRemote = await repo.refExists(remoteFeature);
  const wipOnRemote = await repo.refExists(remoteWip);

  if (!featureOnRemote && !wipOnRemote) {
    if (!(await repo.branchExists(config.mainBranch)) || (await repo.relation(repo.localRef(config.mainBranch), remoteMain)) !== "equal") {
      fail("REMOTE_NOT_CURRENT", "Local main does not match the completed remote stream. Run WipStream: Get Current from Remote or recover local work.");
    }
    for (const branch of [config.featureBranch, config.wipBranch]) {
      if (await repo.branchExists(branch)) {
        if ((await repo.hash(branch)) !== (await repo.hash(config.mainBranch))) {
          fail("LOCAL_CLEANUP_UNSAFE", `Local “${branch}” does not match main and cannot be removed safely.`);
        }
      }
    }
    await cleanupLocalTemporaryBranches(repo, config);
    return "already-finished";
  }

  if (!featureOnRemote || !wipOnRemote) {
    fail("PARTIAL_REMOTE_STREAM", "The remote WipStream is incomplete. Inspect and repair it manually.");
  }

  await assertRemoteTopology(repo, config);
  for (const branch of [config.mainBranch, config.featureBranch, config.wipBranch]) {
    if (!(await repo.branchExists(branch))) {
      fail("LOCAL_BRANCH_MISSING", `Local “${branch}” is missing. Run WipStream: Get Current from Remote first.`);
    }
  }

  const featureHash = await repo.hash(config.featureBranch);
  if (featureHash !== (await repo.hash(config.wipBranch))) {
    fail("UNACCEPTED_WIP", `“${config.wipBranch}” contains work not yet accepted into “${config.featureBranch}”. Run WipStream: To Feature first.`);
  }
  if ((await repo.relation(repo.localRef(config.featureBranch), remoteFeature)) !== "equal" || (await repo.relation(repo.localRef(config.wipBranch), remoteWip)) !== "equal") {
    fail("REMOTE_NOT_CURRENT", "Feature branches do not exactly match the remote. Run WipStream: Get Current from Remote or recover local work.");
  }

  const mainRelation = await repo.relation(repo.localRef(config.mainBranch), remoteMain);
  if (mainRelation === "behind" || mainRelation === "diverged") {
    fail("REMOTE_NOT_CURRENT", "Local main is not current with the remote. Run WipStream: Get Current from Remote before finishing.");
  }
  if (mainRelation === "ahead" && (await repo.hash(config.mainBranch)) !== featureHash) {
    fail("LOCAL_MAIN_AHEAD", "Local main has unrecognized commits and cannot be published safely.");
  }

  if ((await repo.hash(config.mainBranch)) !== featureHash) {
    if (!(await repo.isAncestor(config.mainBranch, config.featureBranch))) {
      fail("INVALID_TOPOLOGY", "Main cannot be fast-forwarded to feature.");
    }
    await repo.switch(config.mainBranch);
    await repo.fastForward(config.featureBranch);
  }

  const leases = {
    [config.featureBranch]: await repo.hash(remoteFeature),
    [config.wipBranch]: await repo.hash(remoteWip),
  };
  await repo.pushAtomic(
    config.remote,
    [refspec(config.mainBranch), `:${config.featureBranch}`, `:${config.wipBranch}`],
    leases
  );
  await cleanupLocalTemporaryBranches(repo, config);
  return "finished";
}
