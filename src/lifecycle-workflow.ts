import { GitRefUpdate, GitRemoteRefUpdate, GitRepository } from "./git";
import {
  getBranchParent,
  inspectBranchInventory,
  readRepositoryConfiguration,
  resolveRemoteDefaultBranch,
  setBranchParent,
  snapshotRemoteTips,
} from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";
import {
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  recoveryRef,
  withMutationBoundary,
} from "./operations";
import {
  commitAndSave,
  CommitAndSaveHooks,
  CommitAndSaveResult,
  getFromRemote,
} from "./generalized-workflow";

export class LifecycleWorkflowError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LifecycleWorkflowError";
    this.code = code;
  }
}

export type ParentSelector = (assumedParent: string) => Promise<string | undefined>;
export type FinishBranchDisposition = "retain" | "delete";

export interface StartBranchResult {
  readonly operationId: string;
  readonly branch: string;
  readonly parent: string;
}

export interface UpdateFromParentResult {
  readonly operationId?: string;
  readonly branch: string;
  readonly parent: string;
  readonly updated: boolean;
}

export interface FinishBranchOptions {
  readonly save?: CommitAndSaveHooks;
  readonly selectParent?: ParentSelector;
  readonly chooseDisposition: () => Promise<FinishBranchDisposition | undefined>;
}

export interface FinishBranchResult {
  readonly operationId: string;
  readonly branch: string;
  readonly parent: string;
  readonly disposition: FinishBranchDisposition;
  readonly save: CommitAndSaveResult;
}

export interface CondensePreview {
  readonly branch: string;
  readonly parent: string;
  readonly oldTip: string;
  readonly exclusiveCommits: number;
}

export interface CondenseBranchOptions {
  readonly selectParent?: ParentSelector;
  readonly confirmPreview: (preview: CondensePreview) => Promise<boolean>;
  readonly requestMessage: (suggestedMessage: string) => Promise<string | undefined>;
}

export interface CondenseBranchResult {
  readonly operationId: string;
  readonly branch: string;
  readonly parent: string;
  readonly oldTip: string;
  readonly newTip: string;
  readonly exclusiveCommits: number;
}

function fail(code: string, message: string): never {
  throw new LifecycleWorkflowError(code, message);
}

async function requireLifecycleRepository(repo: GitRepository, requireClean: boolean): Promise<string> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "WipStream lifecycle commands require a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "WipStream lifecycle commands require complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before using a lifecycle command.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before using a lifecycle command.");
  }
  if (requireClean && (await repo.statusPorcelain()).trim()) {
    fail("DIRTY_WORKTREE", "This lifecycle command requires a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” first.`
    );
  }
  const configuration = await readRepositoryConfiguration(repo);
  if (configuration.kind !== "version2") {
    fail("VERSION_2_REQUIRED", "Initialize or migrate this repository before using lifecycle commands.");
  }
  return configuration.remote;
}

async function resolveParent(
  repo: GitRepository,
  branch: string,
  remote: string,
  selectParent?: ParentSelector
): Promise<string> {
  const recorded = await getBranchParent(repo, branch);
  if (recorded) {
    if (!(await repo.branchExists(recorded))) {
      return fail("PARENT_MISSING", `Recorded parent “${recorded}” does not exist locally.`);
    }
    return recorded;
  }
  const assumed = await resolveRemoteDefaultBranch(repo, remote);
  if (!selectParent) {
    return fail(
      "PARENT_CONFIRMATION_REQUIRED",
      `Confirm “${assumed}” as the parent of imported branch “${branch}” before changing ancestry.`
    );
  }
  const selected = (await selectParent(assumed))?.trim();
  if (!selected) {
    return fail("CANCELLED", "Parent selection was cancelled.");
  }
  if (selected === branch || !(await repo.validateBranchName(selected)) || !(await repo.branchExists(selected))) {
    return fail("INVALID_PARENT", `“${selected}” is not a valid, different local parent branch.`);
  }
  await setBranchParent(repo, branch, selected);
  return selected;
}

async function requireFetchedParity(repo: GitRepository, remote: string): Promise<void> {
  const previous = await snapshotRemoteTips(repo, remote);
  await repo.fetchAllBranches(remote);
  const inventory = await inspectBranchInventory(repo, remote, previous);
  const mismatches = inventory.filter((branch) => branch.relation !== "equal");
  if (mismatches.length) {
    fail(
      "SAVE_REQUIRED",
      `Branches changed since the last handoff (${mismatches.map((branch) => `${branch.name}: ${branch.relation}`).join("; ")}). Run Commit and Save again.`
    );
  }
}

async function verifyParity(repo: GitRepository, remote: string, command: string): Promise<void> {
  const tips = await snapshotRemoteTips(repo, remote);
  const mismatches = (await inspectBranchInventory(repo, remote, tips))
    .filter((branch) => branch.relation !== "equal");
  if (mismatches.length) {
    fail(
      "BRANCH_PARITY_FAILED",
      `${command} did not establish branch parity: ${mismatches.map((branch) => `${branch.name}: ${branch.relation}`).join("; ")}.`
    );
  }
}

export async function startBranch(repo: GitRepository, requestedBranch: string): Promise<StartBranchResult> {
  return withRepositoryCommandLock(repo, "Start Branch", () => startBranchUnlocked(repo, requestedBranch));
}

async function startBranchUnlocked(repo: GitRepository, requestedBranch: string): Promise<StartBranchResult> {
  const remote = await requireLifecycleRepository(repo, false);
  const branch = requestedBranch.trim();
  if (!branch || !(await repo.validateBranchName(branch))) {
    return fail("INVALID_BRANCH", `“${requestedBranch}” is not a valid branch name.`);
  }
  if ((await repo.branchExists(branch)) || (await repo.refExists(repo.remoteRef(remote, branch)))) {
    return fail("BRANCH_EXISTS", `Branch “${branch}” already exists locally or in the fetched remote state.`);
  }
  const parent = await repo.currentBranch();
  if (!parent) {
    return fail("DETACHED_HEAD", "Check out the intended parent before starting a branch.");
  }
  const parentTip = await repo.hash(repo.localRef(parent));
  const plan = createOperationPlan({
    command: "Start Branch",
    localRefUpdates: [{ ref: repo.localRef(branch), expectedOld: null, proposed: parentTip }],
    checkout: { before: parent, after: branch },
  });
  await beginOperation(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switchNewBranch(branch, parentTip));
  await withMutationBoundary(repo, plan.operationId, "configuration", () => setBranchParent(repo, branch, parent));
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, branch, parent };
}

export async function updateFromParent(
  repo: GitRepository,
  selectParent?: ParentSelector
): Promise<UpdateFromParentResult> {
  await getFromRemote(repo);
  return withRepositoryCommandLock(repo, "Update from Parent", () => updateFromParentUnlocked(repo, selectParent));
}

async function updateFromParentUnlocked(
  repo: GitRepository,
  selectParent?: ParentSelector
): Promise<UpdateFromParentResult> {
  const remote = await requireLifecycleRepository(repo, true);
  const branch = await repo.currentBranch();
  if (!branch) {
    return fail("DETACHED_HEAD", "Check out the branch to update.");
  }
  const parent = await resolveParent(repo, branch, remote, selectParent);
  if (await repo.isAncestor(repo.localRef(parent), repo.localRef(branch))) {
    return { branch, parent, updated: false };
  }

  const before = await repo.hash(repo.localRef(branch));
  const plan = createOperationPlan({
    command: "Update from Parent",
    checkout: { before: branch, after: branch },
    destructiveEffects: [{
      kind: "rewrite-local-ref",
      ref: repo.localRef(branch),
      description: `Merge parent ${parent} into ${branch}`,
    }],
  });
  await beginOperation(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "local-refs", () => repo.updateRefs([{
    ref: recoveryRef(plan.operationId, 0),
    expectedOld: null,
    proposed: before,
  }]));
  await withMutationBoundary(repo, plan.operationId, "merge", () => repo.merge(parent));
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, branch, parent, updated: true };
}

export async function finishBranch(repo: GitRepository, options: FinishBranchOptions): Promise<FinishBranchResult> {
  const saved = await commitAndSave(repo, options.save);
  if (!saved.published) {
    return fail("SAVE_HANDOFF_INCOMPLETE", `${saved.message} Finish did not move the parent branch.`);
  }
  return withRepositoryCommandLock(repo, "Finish Branch", () => finishBranchUnlocked(repo, options, saved));
}

async function finishBranchUnlocked(
  repo: GitRepository,
  options: FinishBranchOptions,
  saved: CommitAndSaveResult
): Promise<FinishBranchResult> {
  const remote = await requireLifecycleRepository(repo, true);
  const branch = await repo.currentBranch();
  if (!branch) {
    return fail("DETACHED_HEAD", "Check out the branch to finish.");
  }
  const parent = await resolveParent(repo, branch, remote, options.selectParent);
  await requireFetchedParity(repo, remote);
  if (!(await repo.isAncestor(repo.localRef(parent), repo.localRef(branch)))) {
    return fail(
      "PARENT_UPDATE_REQUIRED",
      `Parent “${parent}” advanced independently. Run Update from Parent before finishing “${branch}”.`
    );
  }
  const disposition = await options.chooseDisposition();
  if (disposition !== "retain" && disposition !== "delete") {
    return fail("CANCELLED", "Finish Branch was cancelled before choosing whether to retain the branch.");
  }

  const parentTip = await repo.hash(repo.localRef(parent));
  const branchTip = await repo.hash(repo.localRef(branch));
  const remoteUpdates: GitRemoteRefUpdate[] = [{
    ref: repo.localRef(parent),
    expected: await repo.hash(repo.remoteRef(remote, parent)),
    proposed: branchTip,
  }];
  if (disposition === "delete") {
    remoteUpdates.push({
      ref: repo.localRef(branch),
      expected: await repo.hash(repo.remoteRef(remote, branch)),
      proposed: null,
    });
  }
  const localUpdates: GitRefUpdate[] = [{
    ref: repo.localRef(parent),
    expectedOld: parentTip,
    proposed: branchTip,
  }];
  if (disposition === "delete") {
    localUpdates.push({ ref: repo.localRef(branch), expectedOld: branchTip, proposed: null });
  }
  const plan = createOperationPlan({
    command: "Finish Branch",
    localRefUpdates: localUpdates,
    remoteRefUpdates: remoteUpdates.map((update) => ({ ref: update.ref, proposed: update.proposed })),
    remoteLeases: remoteUpdates.map((update) => ({ ref: update.ref, expected: update.expected })),
    checkout: { before: branch, after: parent },
    destructiveEffects: [
      { kind: "replace-checkout", ref: repo.localRef(branch), description: `Switch from ${branch} to ${parent}` },
      ...(disposition === "delete" ? [
        { kind: "delete-remote-ref" as const, ref: repo.localRef(branch), description: `Delete remote branch ${branch}` },
        { kind: "delete-local-ref" as const, ref: repo.localRef(branch), description: `Delete local branch ${branch}` },
      ] : []),
    ],
  });
  await beginOperation(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "remote-push", () => repo.pushRefsAtomic(remote, remoteUpdates));
  await withMutationBoundary(repo, plan.operationId, "remote-fetch", () => repo.fetchAllBranches(remote));
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  await applyLocalRefTransaction(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(parent));
  if (disposition === "delete") {
    await withMutationBoundary(repo, plan.operationId, "configuration", () => repo.removeBranchConfiguration(branch));
  }
  await verifyParity(repo, remote, "Finish Branch");
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, branch, parent, disposition, save: saved };
}

export async function condenseBranch(
  repo: GitRepository,
  options: CondenseBranchOptions
): Promise<CondenseBranchResult> {
  return withRepositoryCommandLock(repo, "Condense Branch", () => condenseBranchUnlocked(repo, options));
}

async function condenseBranchUnlocked(
  repo: GitRepository,
  options: CondenseBranchOptions
): Promise<CondenseBranchResult> {
  const remote = await requireLifecycleRepository(repo, true);
  const branch = await repo.currentBranch();
  if (!branch) {
    return fail("DETACHED_HEAD", "Check out the branch to condense.");
  }
  const parent = await resolveParent(repo, branch, remote, options.selectParent);
  await requireFetchedParity(repo, remote);
  if (!(await repo.isAncestor(repo.localRef(parent), repo.localRef(branch)))) {
    return fail("PARENT_UPDATE_REQUIRED", `Update “${branch}” from parent “${parent}” before condensing.`);
  }
  const oldTip = await repo.hash(repo.localRef(branch));
  const parentTip = await repo.hash(repo.localRef(parent));
  const exclusiveCommits = await repo.countCommits(`${repo.localRef(parent)}..${repo.localRef(branch)}`);
  if (exclusiveCommits < 2) {
    return fail("NOTHING_TO_CONDENSE", `Branch “${branch}” has fewer than two exclusive commits.`);
  }
  if (!(await options.confirmPreview({ branch, parent, oldTip, exclusiveCommits }))) {
    return fail("CANCELLED", "Condense Branch was cancelled after preview.");
  }
  const message = (await options.requestMessage(`Condense ${branch}`))?.trim();
  if (!message) {
    return fail("INVALID_CHECKPOINT_MESSAGE", "The condensed commit message cannot be blank.");
  }
  const newTip = await repo.createCommitFromTree(repo.localRef(branch), parentTip, message);
  const remoteUpdate: GitRemoteRefUpdate = {
    ref: repo.localRef(branch),
    expected: await repo.hash(repo.remoteRef(remote, branch)),
    proposed: newTip,
  };
  const plan = createOperationPlan({
    command: "Condense Branch",
    localRefUpdates: [{ ref: repo.localRef(branch), expectedOld: oldTip, proposed: newTip }],
    remoteRefUpdates: [{ ref: remoteUpdate.ref, proposed: newTip }],
    remoteLeases: [{ ref: remoteUpdate.ref, expected: remoteUpdate.expected }],
    checkout: { before: branch, after: branch },
    destructiveEffects: [
      { kind: "rewrite-remote-ref", ref: remoteUpdate.ref, description: `Replace remote ${branch} checkpoints` },
      { kind: "rewrite-local-ref", ref: repo.localRef(branch), description: `Replace local ${branch} checkpoints` },
    ],
  });
  await beginOperation(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "remote-push", () => repo.pushRefsAtomic(remote, [remoteUpdate]));
  await withMutationBoundary(repo, plan.operationId, "remote-fetch", () => repo.fetchAllBranches(remote));
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  await applyLocalRefTransaction(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(branch));
  await verifyParity(repo, remote, "Condense Branch");
  await completeOperation(repo, plan.operationId);
  return { operationId: plan.operationId, branch, parent, oldTip, newTip, exclusiveCommits };
}
