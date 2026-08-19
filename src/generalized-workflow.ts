import { GitError, GitRefUpdate, GitRemoteRefUpdate, GitRepository } from "./git";
import {
  BranchInventoryEntry,
  getBranchParent,
  inspectBranchInventory,
  readRepositoryConfiguration,
  resolveRemoteDefaultBranch,
  snapshotRemoteTips,
  writeRepositoryConfiguration,
} from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";
import {
  applyLocalRefTransaction,
  beginOperation,
  CheckpointTransition,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  recoveryRef,
  withMutationBoundary,
} from "./operations";

export interface UnsafeBranch {
  readonly name: string;
  readonly relation: BranchInventoryEntry["relation"];
  readonly reason: string;
}

export type ParentAdvisoryState = "current" | "probably-integrated" | "parent-advanced" | "parent-missing";

export interface ParentAdvisory {
  readonly branch: string;
  readonly parent: string;
  readonly source: "recorded" | "assumed-default";
  readonly state: ParentAdvisoryState;
}

export interface GetFromRemoteResult {
  readonly operationId: string;
  readonly updated: boolean;
  readonly checkout: string;
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
  readonly advisories: readonly ParentAdvisory[];
}

export interface InitializeRepositoryHooks {
  readonly afterRemotePush?: () => Promise<void>;
}

export interface InitializeRepositoryResult {
  readonly operationId: string;
  readonly checkout: string;
  readonly published: readonly string[];
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
}

export type CommitAndSaveFailure =
  | "offline"
  | "unsafe-branches"
  | "remote-changed"
  | "remote-unavailable"
  | "incomplete";

export interface CommitAndSaveHooks extends InitializeRepositoryHooks {
  readonly saveDocuments?: () => Promise<void>;
  readonly requestCheckpointMessage?: (defaultMessage: string) => Promise<string>;
  readonly beforeRemotePush?: () => Promise<void>;
}

export interface CommitAndSaveResult {
  readonly operationId?: string;
  readonly checkpointCreated: boolean;
  readonly published: boolean;
  readonly handoff: "complete" | "do-not-resume";
  readonly message: string;
  readonly checkout: string;
  readonly publishedBranches: readonly string[];
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
  readonly advisories: readonly ParentAdvisory[];
  readonly failure?: CommitAndSaveFailure;
  readonly unsafeBranches?: readonly UnsafeBranch[];
  readonly reconcileBranch?: string;
}

interface AppliedReconciliationResult {
  readonly operationId: string;
  readonly checkout: string;
  readonly published: readonly string[];
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
}

interface ApplyReconciliationOptions {
  readonly command: string;
  readonly remote: string;
  readonly currentBranch: string;
  readonly targetCheckout: string;
  readonly fetchedRemoteTips: ReadonlyMap<string, string>;
  readonly inventory: readonly BranchInventoryEntry[];
  readonly checkpoint?: CheckpointTransition;
  readonly hooks?: Pick<CommitAndSaveHooks, "beforeRemotePush" | "afterRemotePush">;
  readonly configure?: (synchronizedTips: ReadonlyMap<string, string>) => Promise<void>;
}

export class GeneralizedWorkflowError extends Error {
  public readonly code: string;
  public readonly unsafeBranches: readonly UnsafeBranch[];

  constructor(code: string, message: string, unsafeBranches: readonly UnsafeBranch[] = []) {
    super(message);
    this.name = "GeneralizedWorkflowError";
    this.code = code;
    this.unsafeBranches = unsafeBranches;
  }
}

function fail(code: string, message: string, unsafeBranches: readonly UnsafeBranch[] = []): never {
  throw new GeneralizedWorkflowError(code, message, unsafeBranches);
}

const DO_NOT_RESUME_MESSAGE = "Remote handoff did not complete. Do not resume this work from the remote in another clone.";

function defaultCheckpointMessage(): string {
  return `WIP checkpoint ${new Date().toISOString()}`;
}

function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(could not resolve host|failed to connect|network is unreachable|no route to host|connection timed out|connection reset|could not read from remote|does not appear to be a git repository)/i.test(message);
}

async function requireStableGetRepository(repo: GitRepository): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "Get from Remote requires a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "Get from Remote requires complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before Get from Remote.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before Get from Remote.");
  }
  if ((await repo.statusPorcelain()).trim()) {
    fail("DIRTY_WORKTREE", "Get from Remote requires a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” before Get from Remote.`
    );
  }
}

async function requireStableInitializeRepository(repo: GitRepository): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "Initialize Repository requires a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "Initialize Repository requires complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before Initialize Repository.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before Initialize Repository.");
  }
  if ((await repo.statusPorcelain()).trim()) {
    fail("DIRTY_WORKTREE", "Initialize Repository requires a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” before Initialize Repository.`
    );
  }
}

async function requireStableSaveRepository(repo: GitRepository): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "Commit and Save requires a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "Commit and Save requires complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before Commit and Save.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before Commit and Save.");
  }
  if (await repo.hasDirtySubmodules()) {
    fail("DIRTY_SUBMODULES", "Commit or discard changes inside submodules before Commit and Save.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” before Commit and Save.`
    );
  }
}

function unsafeBranches(inventory: readonly BranchInventoryEntry[]): readonly UnsafeBranch[] {
  const result: UnsafeBranch[] = [];
  for (const branch of inventory) {
    if (["local-ahead", "local-only", "diverged"].includes(branch.relation)) {
      result.push({
        name: branch.name,
        relation: branch.relation,
        reason: branch.relation === "diverged"
          ? "local and remote history diverged"
          : branch.relation === "local-only"
            ? "the branch has no fetched remote counterpart"
            : "the branch contains unpublished local commits",
      });
      continue;
    }
    if (branch.relation === "remotely-deleted" && branch.localTip && branch.localTip !== branch.previousRemoteTip) {
      result.push({
        name: branch.name,
        relation: branch.relation,
        reason: "the branch changed locally after its last observed remote tip",
      });
    }
  }
  return result;
}

function localUpdates(inventory: readonly BranchInventoryEntry[], repo: GitRepository): readonly GitRefUpdate[] {
  return inventory.flatMap((branch) => {
    if (branch.relation === "remote-only") {
      return [{ ref: repo.localRef(branch.name), expectedOld: null, proposed: branch.fetchedRemoteTip ?? null }];
    }
    if (branch.relation === "remote-ahead") {
      return [{ ref: repo.localRef(branch.name), expectedOld: branch.localTip ?? null, proposed: branch.fetchedRemoteTip ?? null }];
    }
    if (branch.relation === "remotely-deleted" && branch.localTip) {
      return [{ ref: repo.localRef(branch.name), expectedOld: branch.localTip, proposed: null }];
    }
    return [];
  });
}

function initializeUnsafeBranches(inventory: readonly BranchInventoryEntry[]): readonly UnsafeBranch[] {
  return inventory.flatMap<UnsafeBranch>((branch) => {
    if (branch.relation === "diverged") {
      return [{ name: branch.name, relation: branch.relation, reason: "local and remote history diverged" }];
    }
    if (branch.relation === "remotely-deleted" && branch.localTip !== branch.previousRemoteTip) {
      return [{
        name: branch.name,
        relation: branch.relation,
        reason: "the branch changed locally after its last observed remote tip",
      }];
    }
    return [];
  });
}

function remoteUpdates(inventory: readonly BranchInventoryEntry[], repo: GitRepository): readonly GitRemoteRefUpdate[] {
  return inventory.flatMap((branch) => {
    if (branch.relation === "local-ahead" || branch.relation === "local-only") {
      return [{
        ref: repo.localRef(branch.name),
        expected: branch.fetchedRemoteTip ?? null,
        proposed: branch.localTip ?? null,
      }];
    }
    return [];
  });
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([name, tip]) => right.get(name) === tip);
}

function inventoryLocalTips(inventory: readonly BranchInventoryEntry[]): ReadonlyMap<string, string> {
  return new Map(inventory.flatMap((branch) => branch.localTip ? [[branch.name, branch.localTip]] : []));
}

async function snapshotLocalTips(repo: GitRepository): Promise<ReadonlyMap<string, string>> {
  const prefix = "refs/heads/";
  return new Map((await repo.listRefs(prefix)).map((ref) => [ref.name.slice(prefix.length), ref.objectId]));
}

async function requireUnchangedInitializeCheckout(
  repo: GitRepository,
  expectedBranch: string,
  expectedTips: ReadonlyMap<string, string>
): Promise<void> {
  if (
    (await repo.currentBranch()) !== expectedBranch
    || !mapsEqual(expectedTips, await snapshotLocalTips(repo))
    || (await repo.statusPorcelain()).trim()
  ) {
    fail(
      "LOCAL_STATE_CHANGED_DURING_INITIALIZE",
      "The checkout, local branches, or working tree changed after Initialize Repository classified them. Inspect the incomplete operation before retrying."
    );
  }
}

async function checkoutAfterGet(
  repo: GitRepository,
  currentBranch: string,
  remoteDefaultBranch: string,
  inventory: readonly BranchInventoryEntry[]
): Promise<string> {
  const current = inventory.find((branch) => branch.name === currentBranch);
  const currentWillBeDeleted = current?.relation === "remotely-deleted" && Boolean(current.localTip);
  if (!currentWillBeDeleted) {
    return currentBranch;
  }
  const recordedParent = await getBranchParent(repo, currentBranch);
  if (recordedParent) {
    const parent = inventory.find((branch) => branch.name === recordedParent);
    if (parent?.fetchedRemoteTip) {
      return recordedParent;
    }
  }
  const fallback = inventory.find((branch) => branch.name === remoteDefaultBranch);
  if (!fallback?.fetchedRemoteTip) {
    return fail("NO_SURVIVING_CHECKOUT", "The deleted current branch has no surviving parent or remote default branch.");
  }
  return remoteDefaultBranch;
}

async function verifyBranchParity(repo: GitRepository, remote: string, command: string): Promise<void> {
  const currentRemoteTips = await snapshotRemoteTips(repo, remote);
  const inventory = await inspectBranchInventory(repo, remote, currentRemoteTips);
  const mismatches = inventory.filter((branch) => branch.relation !== "equal");
  if (mismatches.length) {
    fail(
      "BRANCH_PARITY_FAILED",
      `${command} did not establish branch parity: ${mismatches.map((branch) => `${branch.name} (${branch.relation})`).join(", ")}.`
    );
  }
}

async function parentAdvisories(
  repo: GitRepository,
  remoteDefaultBranch: string,
  inventory: readonly BranchInventoryEntry[]
): Promise<readonly ParentAdvisory[]> {
  const result: ParentAdvisory[] = [];
  const names = new Set(inventory.filter((branch) => branch.fetchedRemoteTip).map((branch) => branch.name));
  for (const branch of [...names].sort()) {
    if (branch === remoteDefaultBranch) {
      continue;
    }
    const recordedParent = await getBranchParent(repo, branch);
    const parent = recordedParent ?? remoteDefaultBranch;
    let state: ParentAdvisoryState;
    if (!names.has(parent)) {
      state = "parent-missing";
    } else if (await repo.isAncestor(repo.localRef(parent), repo.localRef(branch))) {
      state = "current";
    } else if (await repo.isAncestor(repo.localRef(branch), repo.localRef(parent))) {
      state = "probably-integrated";
    } else {
      state = "parent-advanced";
    }
    result.push({ branch, parent, source: recordedParent ? "recorded" : "assumed-default", state });
  }
  return result;
}

async function applyBidirectionalReconciliation(
  repo: GitRepository,
  options: ApplyReconciliationOptions
): Promise<AppliedReconciliationResult> {
  const {
    command,
    remote,
    currentBranch,
    targetCheckout,
    fetchedRemoteTips,
    inventory,
    checkpoint,
    hooks = {},
    configure,
  } = options;
  const classifiedLocalTips = inventoryLocalTips(inventory);
  const publishUpdates = remoteUpdates(inventory, repo);
  const updates = localUpdates(inventory, repo);
  const published = inventory
    .filter((branch) => branch.relation === "local-ahead" || branch.relation === "local-only")
    .map((branch) => branch.name);
  const created = inventory.filter((branch) => branch.relation === "remote-only").map((branch) => branch.name);
  const fastForwarded = inventory.filter((branch) => branch.relation === "remote-ahead").map((branch) => branch.name);
  const deleted = inventory
    .filter((branch) => branch.relation === "remotely-deleted" && branch.localTip)
    .map((branch) => branch.name);
  const currentRefWillChange = updates.some((update) => update.ref === repo.localRef(currentBranch));
  const plan = createOperationPlan({
    command,
    localRefUpdates: updates,
    remoteRefUpdates: publishUpdates.map((update) => ({ ref: update.ref, proposed: update.proposed })),
    remoteLeases: publishUpdates.map((update) => ({ ref: update.ref, expected: update.expected })),
    checkpoint,
    checkout: { before: currentBranch, after: targetCheckout },
    destructiveEffects: [
      ...deleted.map((branch) => ({
        kind: "delete-local-ref" as const,
        ref: repo.localRef(branch),
        description: `Delete local branch ${branch} after proving it still matches the previously fetched remote tip`,
      })),
      ...(currentBranch !== targetCheckout ? [{
        kind: "replace-checkout" as const,
        ref: repo.localRef(currentBranch),
        description: `Replace checkout ${currentBranch} with ${targetCheckout}`,
      }] : []),
    ],
  });
  await beginOperation(repo, plan);

  if (!mapsEqual(fetchedRemoteTips, await snapshotRemoteTips(repo, remote))) {
    return fail(
      "REMOTE_TRACKING_CHANGED",
      `Remote-tracking refs changed after ${command} classified them. Inspect the incomplete operation and retry.`
    );
  }
  await requireUnchangedInitializeCheckout(repo, currentBranch, classifiedLocalTips);
  if (checkpoint && checkpoint.before !== checkpoint.after) {
    await withMutationBoundary(repo, plan.operationId, "local-refs", () => repo.updateRefs([{
      ref: recoveryRef(plan.operationId, updates.length),
      expectedOld: null,
      proposed: checkpoint.before,
    }]));
  }

  if (publishUpdates.length) {
    await hooks.beforeRemotePush?.();
    await withMutationBoundary(repo, plan.operationId, "remote-push", () => repo.pushRefsAtomic(remote, publishUpdates));
    await hooks.afterRemotePush?.();
    await withMutationBoundary(repo, plan.operationId, "remote-fetch", () => repo.fetchAllBranches(remote));
    const expectedRemoteTips = new Map(fetchedRemoteTips);
    for (const update of publishUpdates) {
      expectedRemoteTips.set(update.ref.slice("refs/heads/".length), update.proposed as string);
    }
    if (!mapsEqual(expectedRemoteTips, await snapshotRemoteTips(repo, remote))) {
      return fail(
        "REMOTE_CHANGED_DURING_RECONCILIATION",
        `A remote branch changed while ${command} was publishing. The atomic publication succeeded, but local refs remain unchanged; inspect the incomplete operation and retry.`
      );
    }
    await requireUnchangedInitializeCheckout(repo, currentBranch, classifiedLocalTips);
  }
  if (currentRefWillChange) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  }
  if (updates.length) {
    await applyLocalRefTransaction(repo, plan);
  }
  if (currentRefWillChange || currentBranch !== targetCheckout) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(targetCheckout));
  }

  await verifyBranchParity(repo, remote, command);
  const synchronizedTips = await snapshotRemoteTips(repo, remote);
  if (configure) {
    await withMutationBoundary(repo, plan.operationId, "configuration", () => configure(synchronizedTips));
  }
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, checkout: targetCheckout, published, created, fastForwarded, deleted };
}

export async function initializeRepository(
  repo: GitRepository,
  requestedRemote?: string,
  hooks: InitializeRepositoryHooks = {}
): Promise<InitializeRepositoryResult> {
  return withRepositoryCommandLock(
    repo,
    "Initialize Repository",
    () => initializeRepositoryUnlocked(repo, requestedRemote, hooks)
  );
}

async function initializeRepositoryUnlocked(
  repo: GitRepository,
  requestedRemote: string | undefined,
  hooks: InitializeRepositoryHooks
): Promise<InitializeRepositoryResult> {
  await requireStableInitializeRepository(repo);
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind === "version1") {
    return fail(
      "VERSION_1_MIGRATION_REQUIRED",
      "This repository still uses the version 1 stream model. Run the version 1 migration before generalized initialization."
    );
  }
  const selectedRemote = requestedRemote?.trim();
  if (requestedRemote !== undefined && !selectedRemote) {
    return fail("INVALID_REMOTE", "Initialize Repository requires a non-empty remote name.");
  }
  if (configuration.kind === "version2" && selectedRemote && selectedRemote !== configuration.remote) {
    return fail(
      "REMOTE_MISMATCH",
      `This repository is initialized for remote “${configuration.remote}”, not “${selectedRemote}”.`
    );
  }
  const remote = configuration.kind === "version2" ? configuration.remote : selectedRemote ?? "origin";
  await repo.ensureRemote(remote);
  const currentBranch = await repo.currentBranch();
  if (!currentBranch) {
    return fail("DETACHED_HEAD", "Check out an ordinary branch before Initialize Repository.");
  }

  const previousRemoteTips = await snapshotRemoteTips(repo, remote);
  await inspectBranchInventory(repo, remote, previousRemoteTips);
  await repo.fetchAllBranches(remote);
  const remoteDefaultBranch = await resolveRemoteDefaultBranch(repo, remote);
  const fetchedRemoteTips = await snapshotRemoteTips(repo, remote);
  const inventory = await inspectBranchInventory(repo, remote, previousRemoteTips);
  const unsafe = initializeUnsafeBranches(inventory);
  if (unsafe.length) {
    return fail(
      "INITIALIZE_UNSAFE_BRANCHES",
      `Initialize Repository fetched safely but changed no ordinary local or remote branch because ${unsafe.map((branch) => `${branch.name}: ${branch.reason}`).join("; ")}.`,
      unsafe
    );
  }

  const defaultTip = fetchedRemoteTips.get(remoteDefaultBranch);
  if (!defaultTip) {
    return fail("REMOTE_DEFAULT_MISSING", `Remote default branch “${remoteDefaultBranch}” has no fetched tip.`);
  }
  await repo.verifyAtomicPushSupport(remote, repo.localRef(remoteDefaultBranch), defaultTip);
  return applyBidirectionalReconciliation(repo, {
    command: "Initialize Repository",
    remote,
    currentBranch,
    targetCheckout: remoteDefaultBranch,
    fetchedRemoteTips,
    inventory,
    hooks,
    configure: async (synchronizedTips) => {
      await repo.configureFullBranchFetch(remote);
      for (const branch of [...synchronizedTips.keys()].sort()) {
        await repo.configureTracking(branch, remote);
      }
      const expectedFetch = `+refs/heads/*:refs/remotes/${remote}/*`;
      if (!(await repo.getConfigValues(`remote.${remote}.fetch`)).includes(expectedFetch)) {
        return fail(
          "FULL_FETCH_CONFIGURATION_FAILED",
          `Initialize Repository could not configure full branch fetches for “${remote}”.`
        );
      }
      await writeRepositoryConfiguration(repo, { remote });
    },
  });
}

export async function commitAndSave(
  repo: GitRepository,
  hooks: CommitAndSaveHooks = {}
): Promise<CommitAndSaveResult> {
  return withRepositoryCommandLock(repo, "Commit and Save", () => commitAndSaveUnlocked(repo, hooks));
}

async function commitAndSaveUnlocked(
  repo: GitRepository,
  hooks: CommitAndSaveHooks
): Promise<CommitAndSaveResult> {
  await hooks.saveDocuments?.();
  await requireStableSaveRepository(repo);
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind !== "version2") {
    return fail("VERSION_2_REQUIRED", "Initialize or migrate this repository before using generalized Commit and Save.");
  }
  await repo.ensureRemote(configuration.remote);
  const currentBranch = await repo.currentBranch();
  if (!currentBranch) {
    return fail("DETACHED_HEAD", "Check out an ordinary branch before Commit and Save.");
  }

  const beforeCheckpoint = await repo.hash(repo.localRef(currentBranch));
  await repo.stageAll();
  const checkpointCreated = await repo.hasStagedChanges();
  let checkpoint: CheckpointTransition | undefined;
  if (checkpointCreated) {
    const suggestedMessage = defaultCheckpointMessage();
    const requestedMessage = hooks.requestCheckpointMessage
      ? await hooks.requestCheckpointMessage(suggestedMessage)
      : suggestedMessage;
    const message = requestedMessage?.trim();
    if (!message) {
      return fail("INVALID_CHECKPOINT_MESSAGE", "Checkpoint commit messages cannot be blank.");
    }
    await repo.commit(message);
    checkpoint = {
      branch: currentBranch,
      before: beforeCheckpoint,
      after: await repo.hash(repo.localRef(currentBranch)),
      message,
    };
  }
  if ((await repo.statusPorcelain()).trim()) {
    return fail(
      "WORKTREE_CHANGED_DURING_CHECKPOINT",
      "The working tree changed while creating the checkpoint. The checkpoint is retained locally; inspect the remaining files before retrying."
    );
  }

  const unsuccessful = (
    failure: CommitAndSaveFailure,
    message: string,
    details: {
      operationId?: string;
      unsafeBranches?: readonly UnsafeBranch[];
      reconcileBranch?: string;
    } = {}
  ): CommitAndSaveResult => ({
    ...details,
    checkpointCreated,
    published: false,
    handoff: "do-not-resume",
    message: `${message} ${DO_NOT_RESUME_MESSAGE}`,
    checkout: currentBranch,
    publishedBranches: [],
    created: [],
    fastForwarded: [],
    deleted: [],
    advisories: [],
    failure,
  });

  const previousRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  try {
    await repo.fetchAllBranches(configuration.remote);
  } catch (error) {
    if (error instanceof GitError) {
      return unsuccessful(
        isNetworkFailure(error) ? "offline" : "remote-unavailable",
        isNetworkFailure(error)
          ? "The local checkpoint is safe, but the remote could not be reached."
          : "The local checkpoint is safe, but the remote did not permit synchronization."
      );
    }
    throw error;
  }
  const remoteDefaultBranch = await resolveRemoteDefaultBranch(repo, configuration.remote);
  const fetchedRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  const inventory = await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  const unsafe = initializeUnsafeBranches(inventory);
  if (unsafe.length) {
    const reconcileBranch = unsafe.some(
      (branch) => branch.name === currentBranch && branch.relation === "diverged"
    ) ? currentBranch : undefined;
    return unsuccessful(
      "unsafe-branches",
      `The local checkpoint is safe, but automatic reconciliation stopped because ${unsafe.map((branch) => `${branch.name}: ${branch.reason}`).join("; ")}.`,
      { unsafeBranches: unsafe, reconcileBranch }
    );
  }

  const targetCheckout = await checkoutAfterGet(repo, currentBranch, remoteDefaultBranch, inventory);
  let applied: AppliedReconciliationResult;
  try {
    applied = await applyBidirectionalReconciliation(repo, {
      command: "Commit and Save",
      remote: configuration.remote,
      currentBranch,
      targetCheckout,
      fetchedRemoteTips,
      inventory,
      checkpoint,
      hooks,
      configure: async (synchronizedTips) => {
        for (const branch of [...synchronizedTips.keys()].sort()) {
          await repo.configureTracking(branch, configuration.remote);
        }
      },
    });
  } catch (error) {
    const incomplete = (await inspectIncompleteOperations(repo))[0];
    if (!incomplete) {
      throw error;
    }
    const details = { operationId: incomplete.plan.operationId };
    if (error instanceof GitError && isNetworkFailure(error)) {
      return unsuccessful(
        "offline",
        `The local checkpoint is safe, but the network failed during the handoff at phase “${incomplete.phase}”.`,
        details
      );
    }
    if (incomplete.phase === "before-remote-push") {
      const remoteChanged = error instanceof GitError && /(stale info|fetch first|\[rejected\])/i.test(error.message);
      return unsuccessful(
        remoteChanged ? "remote-changed" : "remote-unavailable",
        remoteChanged
          ? "The remote rejected the complete exact-leased atomic publication because its branch state changed."
          : "The remote did not accept the complete atomic publication.",
        details
      );
    }
    return unsuccessful(
      "incomplete",
      `The handoff stopped at phase “${incomplete.phase}”. Inspect operation “${incomplete.plan.operationId}” and its recorded local and remote state before continuing.`,
      details
    );
  }

  const currentInventory = await inspectBranchInventory(
    repo,
    configuration.remote,
    await snapshotRemoteTips(repo, configuration.remote)
  );
  const advisories = await parentAdvisories(repo, remoteDefaultBranch, currentInventory);
  return {
    ...applied,
    checkpointCreated,
    published: true,
    handoff: "complete",
    message: checkpointCreated
      ? "Checkpoint committed and every ordinary branch is synchronized. It is safe to resume from the remote."
      : "Every ordinary branch is synchronized. It is safe to resume from the remote.",
    publishedBranches: applied.published,
    advisories,
  };
}

export async function getFromRemote(repo: GitRepository): Promise<GetFromRemoteResult> {
  return withRepositoryCommandLock(repo, "Get from Remote", () => getFromRemoteUnlocked(repo));
}

async function getFromRemoteUnlocked(repo: GitRepository): Promise<GetFromRemoteResult> {
  await requireStableGetRepository(repo);
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind !== "version2") {
    return fail("VERSION_2_REQUIRED", "Initialize or migrate this repository before using generalized Get from Remote.");
  }
  await repo.ensureRemote(configuration.remote);
  const currentBranch = await repo.currentBranch();
  if (!currentBranch) {
    return fail("DETACHED_HEAD", "Check out an ordinary branch before Get from Remote.");
  }

  const previousRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  await repo.fetchAllBranches(configuration.remote);
  const remoteDefaultBranch = await resolveRemoteDefaultBranch(repo, configuration.remote);
  const fetchedRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  const inventory = await inspectBranchInventory(repo, configuration.remote, previousRemoteTips);
  const unsafe = unsafeBranches(inventory);
  if (unsafe.length) {
    return fail(
      "GET_UNSAFE_BRANCHES",
      `Get from Remote fetched safely but did not move local branches because ${unsafe.map((branch) => `${branch.name}: ${branch.reason}`).join("; ")}.`,
      unsafe
    );
  }

  const updates = localUpdates(inventory, repo);
  const targetCheckout = await checkoutAfterGet(repo, currentBranch, remoteDefaultBranch, inventory);
  const created = inventory.filter((branch) => branch.relation === "remote-only").map((branch) => branch.name);
  const fastForwarded = inventory.filter((branch) => branch.relation === "remote-ahead").map((branch) => branch.name);
  const deleted = inventory
    .filter((branch) => branch.relation === "remotely-deleted" && branch.localTip)
    .map((branch) => branch.name);
  const currentRef = repo.localRef(currentBranch);
  const replaceCheckout = updates.some((update) => update.ref === currentRef);
  const plan = createOperationPlan({
    command: "Get from Remote",
    localRefUpdates: updates,
    checkout: { before: currentBranch, after: targetCheckout },
    destructiveEffects: [
      ...deleted.map((branch) => ({
        kind: "delete-local-ref" as const,
        ref: repo.localRef(branch),
        description: `Delete local branch ${branch} after proving it still matches the previously fetched remote tip`,
      })),
      ...(targetCheckout !== currentBranch ? [{
        kind: "replace-checkout" as const,
        ref: repo.localRef(currentBranch),
        description: `Replace the deleted checkout ${currentBranch} with ${targetCheckout}`,
      }] : []),
    ],
  });
  await beginOperation(repo, plan);

  if (!mapsEqual(fetchedRemoteTips, await snapshotRemoteTips(repo, configuration.remote))) {
    return fail(
      "REMOTE_TRACKING_CHANGED",
      "Remote-tracking refs changed after Get from Remote classified them. Inspect the incomplete operation and retry."
    );
  }
  if (updates.length && (await repo.statusPorcelain()).trim()) {
    return fail(
      "WORKTREE_CHANGED_DURING_GET",
      "The working tree changed after Get from Remote preflight. Inspect the incomplete operation before retrying."
    );
  }

  if (replaceCheckout) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  }
  if (updates.length) {
    await applyLocalRefTransaction(repo, plan);
  }
  if (created.length) {
    await withMutationBoundary(repo, plan.operationId, "configuration", async () => {
      for (const branch of created) {
        await repo.configureTracking(branch, configuration.remote);
      }
    });
  }
  if (replaceCheckout) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(targetCheckout));
  }

  await verifyBranchParity(repo, configuration.remote, "Get from Remote");
  const currentInventory = await inspectBranchInventory(
    repo,
    configuration.remote,
    await snapshotRemoteTips(repo, configuration.remote)
  );
  const advisories = await parentAdvisories(repo, remoteDefaultBranch, currentInventory);
  await completeOperation(repo, plan.operationId);
  return {
    operationId: plan.operationId,
    updated: updates.length > 0,
    checkout: targetCheckout,
    created,
    fastForwarded,
    deleted,
    advisories,
  };
}
