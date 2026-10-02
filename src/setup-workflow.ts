import { createHash } from "crypto";
import { fail, WipStreamError } from "./errors";
import { GitRepository } from "./git";
import {
  BranchInventoryEntry,
  inspectBranchInventory,
  readRepositoryConfiguration,
  snapshotRemoteTrackingTips,
} from "./repository-model";
import { requireRepositoryPreflight, withRepositoryWorkflow } from "./repository-safety";
import { snapshotWorkingFiles } from "./project-snapshot";
import {
  AppliedReconciliationResult,
  applyBidirectionalReconciliation,
  CommitAndSaveHooks,
  createCheckpoint,
  initializationConfigurationChanges,
  initializationRemoteHead,
} from "./generalized-workflow";
import { CheckpointTransition, inspectIncompleteOperations, listOperationReceipts } from "./operations";
import { backupProjectUnlocked, ProjectBackupError } from "./project-backup";
import { adoptRemoteUnlocked } from "./remote-adoption";

export interface SetupEditorState {
  readonly signature: string;
  readonly dirty: boolean;
}

export interface SetupInspectionHooks {
  readonly readEditorState?: () => SetupEditorState;
  readonly signal?: AbortSignal;
}

export interface SetupLocalState {
  readonly checkout?: string;
  readonly head: string;
  readonly branches: readonly { readonly name: string; readonly tip: string }[];
  readonly status: string;
  readonly files: string;
  readonly index: string;
  readonly configuration: string;
  readonly editors: Readonly<SetupEditorState>;
}

export interface SetupInspection {
  readonly repositoryRoot: string;
  readonly remote: string;
  readonly remoteDefaultBranch: string;
  readonly remoteTips: readonly { readonly name: string; readonly tip: string }[];
  readonly branches: readonly BranchInventoryEntry[];
  readonly local: Readonly<SetupLocalState>;
  readonly requiresChoice: boolean;
  readonly reconciliationBranches: readonly string[];
}

export type SetupChoice =
  | { readonly kind: "cancel" }
  | { readonly kind: "reconcile" }
  | { readonly kind: "remote"; readonly backup: { readonly kind: "copy"; readonly parent: string } | { readonly kind: "discard"; readonly confirmed: true } }
  | { readonly kind: "local-work" };

export interface SetupExecutionHooks extends SetupInspectionHooks, CommitAndSaveHooks {}

export type SetupResult = (
  | ({ readonly kind: "completed"; readonly checkpointCreated: boolean; readonly published: boolean; readonly publishedBranches: readonly string[]; readonly replaced?: readonly string[] } & Omit<AppliedReconciliationResult, "published">)
  | { readonly kind: "cancelled"; readonly checkpointCreated: boolean; readonly published: false; readonly message: string }
  | { readonly kind: "preview-required"; readonly checkpointCreated: boolean; readonly published: false; readonly message: string }
  | { readonly kind: "reconciliation-required"; readonly checkpointCreated: boolean; readonly published: false; readonly branches: readonly string[]; readonly message: string }
  | { readonly kind: "failed"; readonly checkpointCreated: boolean; readonly published: false; readonly operationId?: string; readonly message: string }
) & { readonly backupPath?: string };

function requireNotCancelled(hooks: SetupInspectionHooks): void {
  if (hooks.signal?.aborted) return fail("CANCELLED", "Initialize Repository was cancelled.");
}

export async function inspectSetupLocalState(repo: GitRepository, hooks: SetupInspectionHooks = {}): Promise<SetupLocalState> {
  requireNotCancelled(hooks);
  const editors = hooks.readEditorState?.() ?? { signature: "", dirty: false };
  const index = createHash("sha256").update(JSON.stringify(await repo.indexEntries())).digest("hex");
  const state: SetupLocalState = {
    checkout: await repo.currentBranch(),
    head: await repo.hash("HEAD"),
    branches: Object.freeze((await repo.listRefs("refs/heads/")).map(ref => Object.freeze({
      name: ref.name.slice("refs/heads/".length), tip: ref.objectId,
    }))),
    // Avoid Git's optional index refresh: inspection must not change staged state.
    status: await repo.runRaw(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
    files: (await snapshotWorkingFiles(repo, hooks.signal)).fingerprint,
    index,
    configuration: await repo.runRaw(["config", "--local", "--null", "--list"]),
    editors: Object.freeze({ ...editors }),
  };
  if (JSON.stringify(editors) !== JSON.stringify(hooks.readEditorState?.() ?? editors)) {
    return fail("SETUP_STATE_CHANGED", "Editor documents changed during setup inspection. Run Initialize Repository again for a fresh preview.");
  }
  return Object.freeze(state);
}

function statesEqual(left: SetupLocalState, right: SetupLocalState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function setupReconciliationMessage(branches: readonly string[], checkpointCreated: boolean): string {
  const saved = checkpointCreated ? "The checkpoint is saved locally. " : "Your existing local work is retained. ";
  return `${saved}Nothing was published. Resolve differences on ${branches.length ? branches.map(branch => `“${branch}”`).join(", ") : "the affected branches"} in your Git tool, incorporating the selected remote's history into each branch you want to publish. Matching file contents alone does not resolve divergent history. Then rerun Initialize Repository and choose Commit this machine’s work and save to remote.`;
}

/** Caller holds the command lock; inspection never saves, publishes, or replaces work. */
export async function inspectRepositorySetupUnlocked(
  repo: GitRepository,
  requestedRemote?: string,
  hooks: SetupInspectionHooks = {}
): Promise<SetupInspection> {
  await requireRepositoryPreflight(repo, { command: "Initialize Repository", cleanWorktree: false, cleanSubmodules: false });
  requireNotCancelled(hooks);
  const configuration = await readRepositoryConfiguration(repo);
  const remote = requestedRemote?.trim() ?? (configuration.kind === "initialized" ? configuration.remote : "origin");
  if (!remote) return fail("INVALID_REMOTE", "Initialize Repository requires a non-empty remote name.");
  if (configuration.kind === "initialized" && remote !== configuration.remote) {
    return fail("REMOTE_MISMATCH", `This repository is configured for remote “${configuration.remote}”, not “${remote}”.`);
  }
  await repo.requireConfiguredRemote(remote);
  const previousTips = await snapshotRemoteTrackingTips(repo, remote);
  await repo.fetchAllBranches(remote);
  const remoteDefaultBranch = await repo.readRemoteDefaultBranch(remote);
  const remoteTips = await snapshotRemoteTrackingTips(repo, remote);
  if (!remoteTips.has(remoteDefaultBranch)) return fail("REMOTE_DEFAULT_MISSING", `Remote default branch “${remoteDefaultBranch}” has no fetched commit.`);
  const branches = await inspectBranchInventory(repo, remote, previousTips);
  const local = await inspectSetupLocalState(repo, hooks);
  if (!local.checkout) {
    const keptAdoption = (await listOperationReceipts(repo)).some(receipt => receipt.plan.remoteAdoption
      && receipt.status === "recovered" && receipt.recovery?.resolution === "kept-current-state"
      && !receipt.recovery.branch && receipt.recovery.head === local.head);
    if (!keptAdoption) return fail("DETACHED_HEAD", "Check out an ordinary branch before Initialize Repository. For interrupted remote adoption, first run Recover Incomplete Operation and keep the current state.");
  }
  const branchesDiffer = branches.some(branch => !["equal", "remote-only"].includes(branch.relation));
  const requiresChoice = !local.checkout || Boolean(local.status) || local.editors.dirty || branchesDiffer;
  const reconciliationBranches = branches.filter(branch => {
    if (branch.relation === "diverged") return true;
    return branch.relation === "remotely-deleted" && Boolean(branch.localTip)
      && branch.localTip !== branch.previousRemoteTip;
  }).map(branch => branch.name);
  return Object.freeze({
    repositoryRoot: repo.root,
    remote,
    remoteDefaultBranch,
    remoteTips: Object.freeze([...remoteTips].map(([name, tip]) => Object.freeze({ name, tip }))),
    branches: Object.freeze(branches.map(branch => Object.freeze({ ...branch }))),
    local,
    requiresChoice,
    reconciliationBranches: Object.freeze(reconciliationBranches),
  });
}

export async function inspectRepositorySetup(
  repo: GitRepository,
  requestedRemote?: string,
  hooks: SetupInspectionHooks = {}
): Promise<SetupInspection> {
  return withRepositoryWorkflow(repo, "Inspect Repository Setup", () => inspectRepositorySetupUnlocked(repo, requestedRemote, hooks));
}

async function requireApprovedSetupState(repo: GitRepository, inspection: SetupInspection, hooks: SetupInspectionHooks): Promise<void> {
  requireNotCancelled(hooks);
  if (repo.root !== inspection.repositoryRoot || !statesEqual(inspection.local, await inspectSetupLocalState(repo, hooks))) {
    return fail("SETUP_STATE_CHANGED", "Files, branches, index, configuration, or editor documents changed after the setup preview. Review a fresh preview before proceeding.");
  }
  await repo.fetchAllBranches(inspection.remote);
  const remoteTips = [...await snapshotRemoteTrackingTips(repo, inspection.remote)].map(([name, tip]) => ({ name, tip }));
  if (JSON.stringify(inspection.remoteTips) !== JSON.stringify(remoteTips)
    || await repo.readRemoteDefaultBranch(inspection.remote) !== inspection.remoteDefaultBranch) {
    return fail("SETUP_STATE_CHANGED", "The remote changed after the setup preview. Review a fresh preview before proceeding.");
  }
  if (!statesEqual(inspection.local, await inspectSetupLocalState(repo, hooks))) {
    return fail("SETUP_STATE_CHANGED", "Local work changed while rechecking the remote. Review a fresh setup preview.");
  }
}

export async function executeRepositorySetup(
  repo: GitRepository,
  inspection: SetupInspection,
  choice: SetupChoice,
  hooks: SetupExecutionHooks = {}
): Promise<SetupResult> {
  if (choice.kind === "cancel") {
    return {
      kind: "cancelled",
      checkpointCreated: false,
      published: false,
      message: "Setup cancelled; local work was not saved or published by this attempt.",
    };
  }
  if (choice.kind === "remote" && choice.backup.kind === "discard" && choice.backup.confirmed !== true) {
    return {
      kind: "failed",
      checkpointCreated: false,
      published: false,
      message: "Explicit confirmation is required to replace local work without a backup. No files were saved or replaced, and nothing was published.",
    };
  }
  if (choice.kind === "reconcile") {
    let branches = inspection.reconciliationBranches;
    if (!branches.length) {
      branches = inspection.branches.filter(branch => branch.localTip && branch.relation !== "equal").map(branch => branch.name);
    }
    if (!branches.length && inspection.local.checkout) branches = [inspection.local.checkout];
    return {
      kind: "reconciliation-required", checkpointCreated: false, published: false,
      branches, message: setupReconciliationMessage(branches, false),
    };
  }
  return withRepositoryWorkflow(repo, "Initialize Repository", async () => {
    let checkpoint: CheckpointTransition | undefined;
    let backupPath: string | undefined;
    let operationId: string | undefined;
    try {
      await requireRepositoryPreflight(repo, { command: "Initialize Repository", cleanWorktree: false, cleanSubmodules: true });
      await requireApprovedSetupState(repo, inspection, hooks);
      await hooks.saveDocuments?.();
      // Saving can change both disk contents and editor dirty/version state.
      // The old approval no longer describes those files, so return for preview.
      if (hooks.saveDocuments && !statesEqual(inspection.local, await inspectSetupLocalState(repo, hooks))) {
        return {
          kind: "preview-required",
          checkpointCreated: false,
          published: false,
          message: "Setup state changed while saving editor documents. Review the updated setup preview before committing or replacing files.",
        };
      }
      requireNotCancelled(hooks);
      if (choice.kind === "remote") {
        if (choice.backup.kind === "copy") {
          backupPath = (await backupProjectUnlocked(repo, choice.backup.parent, { signal: hooks.signal })).path;
        } else if (choice.backup.confirmed !== true) {
          return fail("REMOTE_DISCARD_NOT_CONFIRMED", "Explicit confirmation is required to replace local work without a backup.");
        }
        const backup = backupPath ? { kind: "verified-copy" as const, path: backupPath } : { kind: "explicit-discard" as const };
        const adopted = await adoptRemoteUnlocked(
          repo,
          inspection,
          backup,
          () => requireApprovedSetupState(repo, inspection, hooks),
          hooks.signal,
          id => { operationId = id; }
        );
        return {
          kind: "completed",
          ...adopted,
          checkpointCreated: false,
          published: false,
          publishedBranches: [],
          backupPath,
        };
      }
      const currentBranch = inspection.local.checkout;
      if (!currentBranch) return fail("DETACHED_HEAD", "Check out an ordinary branch before saving this machine's work.");
      await createCheckpoint(repo, currentBranch, {
        onCheckpoint: created => { checkpoint = created; },
        requestCheckpointMessage: async suggested => {
          const beforePrompt = await inspectSetupLocalState(repo, hooks);
          const message = hooks.requestCheckpointMessage ? await hooks.requestCheckpointMessage(suggested) : suggested;
          requireNotCancelled(hooks);
          if (!statesEqual(beforePrompt, await inspectSetupLocalState(repo, hooks))) {
            return fail("SETUP_STATE_CHANGED", "Local work changed while entering the checkpoint message. Review a fresh setup preview.");
          }
          return message;
        },
      });
      requireNotCancelled(hooks);
      const afterCheckpoint = await inspectSetupLocalState(repo, hooks);
      const previousTips = new Map(inspection.remoteTips.map(({ name, tip }) => [name, tip]));
      for (const branch of inspection.branches) {
        if (branch.previousRemoteTip && !branch.fetchedRemoteTip) previousTips.set(branch.name, branch.previousRemoteTip);
      }
      await repo.fetchAllBranches(inspection.remote);
      const inventory = await inspectBranchInventory(repo, inspection.remote, previousTips);
      const affected = inventory.filter(branch => {
        if (branch.relation === "diverged") return true;
        return branch.relation === "remotely-deleted" && Boolean(branch.localTip)
          && branch.localTip !== branch.previousRemoteTip;
      }).map(branch => branch.name);
      if (affected.length) return {
        kind: "reconciliation-required", checkpointCreated: Boolean(checkpoint), published: false,
        branches: affected, message: setupReconciliationMessage(affected, Boolean(checkpoint)),
      };
      const fetchedRemoteTips = await snapshotRemoteTrackingTips(repo, inspection.remote);
      const remoteDefaultBranch = await repo.readRemoteDefaultBranch(inspection.remote);
      const defaultTip = fetchedRemoteTips.get(remoteDefaultBranch);
      if (!defaultTip) return fail("REMOTE_DEFAULT_MISSING", "The remote default branch disappeared; rerun Initialize Repository.");
      await repo.verifyAtomicPushSupport(inspection.remote, repo.localRef(remoteDefaultBranch), defaultTip);
      const synchronizedBranches = [...new Set([
        ...fetchedRemoteTips.keys(),
        ...inventory.filter(branch => branch.relation === "local-only").map(branch => branch.name),
      ])].sort();
      const configurationChanges = await initializationConfigurationChanges(repo, inspection.remote, synchronizedBranches);
      const remoteHead = await initializationRemoteHead(repo, inspection.remote, remoteDefaultBranch);
      requireNotCancelled(hooks);
      const requireUnchangedCheckpointState = async (): Promise<void> => {
        requireNotCancelled(hooks);
        if (!statesEqual(afterCheckpoint, await inspectSetupLocalState(repo, hooks))) {
          return fail("SETUP_STATE_CHANGED", "Local work or editor documents changed after the checkpoint. Inspect any incomplete operation before a fresh setup attempt.");
        }
      };
      const applied = await applyBidirectionalReconciliation(repo, {
        command: "Initialize Repository",
        remote: inspection.remote,
        currentBranch,
        targetCheckout: remoteDefaultBranch,
        fetchedRemoteTips,
        inventory,
        checkpoint,
        configurationChanges,
        remoteHead,
        hooks: {
          onOperationStarted: id => { operationId = id; },
          beforeRemotePush: async () => {
            await hooks.beforeRemotePush?.();
            await requireUnchangedCheckpointState();
          },
          afterRemotePush: hooks.afterRemotePush,
          beforeLocalMutation: requireUnchangedCheckpointState,
        },
      });
      const { published: publishedBranches, ...effects } = applied;
      return { kind: "completed", ...effects, checkpointCreated: Boolean(checkpoint), published: true, publishedBranches };
    } catch (error) {
      if (error instanceof ProjectBackupError) backupPath = error.backupPath;
      const incomplete = (await inspectIncompleteOperations(repo)).find(receipt => receipt.plan.operationId === operationId);
      const message = error instanceof Error ? error.message : String(error);
      const saved = checkpoint ? "The checkpoint is saved locally. " : "Local files and existing commits are retained. ";
      const backupMessage = backupPath ? ` Backup retained at ${backupPath}.` : "";
      const failureMessage = choice.kind === "remote" ? "Remote adoption did not complete. " : `${saved}Remote saving did not complete. `;
      if (incomplete) return {
        kind: "failed", operationId: incomplete.plan.operationId, backupPath,
        checkpointCreated: Boolean(checkpoint), published: false,
        message: `${failureMessage}Recorded phase: ${incomplete.phase}. ${message}${backupMessage} Run Recover Incomplete Operation before retrying Initialize. Do not resume this work from the remote on another machine.`,
      };
      if (error instanceof WipStreamError && error.code === "SETUP_STATE_CHANGED") {
        return {
          kind: "preview-required",
          checkpointCreated: Boolean(checkpoint),
          published: false,
          backupPath,
          message: `${saved}${message}${backupMessage}`,
        };
      }
      if (hooks.signal?.aborted || error instanceof WipStreamError && error.code === "CANCELLED") {
        return {
          kind: "cancelled",
          checkpointCreated: Boolean(checkpoint),
          published: false,
          backupPath,
          message: `${saved}Setup was cancelled; nothing was published.${backupMessage}`,
        };
      }
      return {
        kind: "failed",
        checkpointCreated: Boolean(checkpoint),
        published: false,
        backupPath,
        message: `${saved}Nothing was published. ${message}${backupMessage}`,
      };
    }
  });
}
