import { fail } from "./errors";
import { GitRefUpdate, GitRepository } from "./git";
import { initializationConfigurationChanges } from "./generalized-workflow";
import {
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  RemoteAdoption,
  withMutationBoundary,
} from "./operations";
import { snapshotProject } from "./project-snapshot";
import { snapshotRemoteTrackingTips } from "./repository-model";
import type { SetupInspection } from "./setup-workflow";

export interface RemoteAdoptionResult {
  readonly operationId: string;
  readonly checkout: string;
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly replaced: readonly string[];
  readonly deleted: readonly string[];
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** The setup orchestrator owns the lock, backup, editor saving, and approval. */
export async function adoptRemoteUnlocked(
  repo: GitRepository,
  inspection: SetupInspection,
  backup: RemoteAdoption["backup"],
  revalidate: () => Promise<void>,
  signal?: AbortSignal
): Promise<RemoteAdoptionResult> {
  const remoteTips = new Map(inspection.remoteTips.map(({ name, tip }) => [name, tip]));
  const localTips = new Map(inspection.local.branches.map(({ name, tip }) => [name, tip]));
  const defaultTip = remoteTips.get(inspection.remoteDefaultBranch);
  if (!defaultTip) return fail("REMOTE_DEFAULT_MISSING", "The approved remote default branch has no fetched commit.");
  const targetTree = await repo.treePaths(defaultTip);
  const currentTree = await repo.treePaths(inspection.local.head);
  if ([...currentTree, ...targetTree].some(entry => entry.mode === "160000")) {
    return fail("REMOTE_ADOPTION_SUBMODULES", "Remote replacement requires a project without submodule checkouts. Retain this clone and its backup; reconcile submodule work in your Git tool before using the local-work setup path.");
  }
  const worktree = await snapshotProject(repo.root, [".git"], signal);
  const trackedPaths = new Set([...await repo.trackedPaths(), ...currentTree.map(entry => entry.name)]);
  const untracked = worktree.entries.filter(entry => entry.name && !trackedPaths.has(entry.name)
    && (entry.kind !== "directory" || ![...trackedPaths].some(name => name.startsWith(`${entry.name}/`))));
  const ignored = new Set(await repo.ignoredPaths(untracked.map(entry => entry.name)));
  const protectedEntries = worktree.entries.filter(entry => ignored.has(entry.name));
  const caseInsensitive = await repo.getConfig("core.ignorecase") === "true";
  const normalize = (name: string): string => caseInsensitive ? name.toLowerCase() : name;
  const collisions = targetTree.filter(target => protectedEntries.some(entry => pathsOverlap(normalize(entry.name), normalize(target.name))));
  if (collisions.length) {
    return fail("IGNORED_PATH_COLLISION", `Remote files would overwrite ignored local work: ${collisions.map(entry => entry.name).join(", ")}. Move those ignored files to a safe location and review a new setup preview before replacement.`);
  }
  const removedFiles = untracked.filter(entry => entry.kind !== "directory" && !ignored.has(entry.name)).map(entry => entry.name);
  const removedDirectories = untracked.filter(entry => entry.kind === "directory" && !ignored.has(entry.name)).map(entry => entry.name);
  const names = [...new Set([...localTips.keys(), ...remoteTips.keys()])].sort();
  // Include equal tips as exact-old checks in the same transaction.
  const updates: GitRefUpdate[] = names.map(name => ({
    ref: repo.localRef(name), expectedOld: localTips.get(name) ?? null, proposed: remoteTips.get(name) ?? null,
  }));
  const deleted = names.filter(name => localTips.has(name) && !remoteTips.has(name));
  const configuration = [...await initializationConfigurationChanges(repo, inspection.remote, [...remoteTips.keys()])];
  // Preserve unrelated configuration, including similarly prefixed branch names.
  const marker = configuration.pop();
  for (const branch of deleted) {
    for (const key of await repo.branchConfigurationKeys(branch)) {
      configuration.push({ key, before: await repo.getConfigValues(key), after: [] });
    }
  }
  if (marker) configuration.push(marker);
  const plan = createOperationPlan({
    command: "Adopt Remote for Setup",
    localRefUpdates: updates,
    checkout: { before: inspection.local.checkout, after: inspection.remoteDefaultBranch },
    configurationChanges: configuration,
    remoteAdoption: {
      remote: inspection.remote, remoteDefaultBranch: inspection.remoteDefaultBranch,
      fetchedTips: inspection.remoteTips, worktreeFingerprint: inspection.local.files,
      trackedPaths: [...new Set([...trackedPaths, ...targetTree.map(entry => entry.name)])].sort(),
      removedUntrackedPaths: [...removedFiles, ...removedDirectories],
      preservedIgnoredPaths: [...ignored].sort(), backup,
    },
    destructiveEffects: [
      { kind: "replace-files", description: "Replace tracked files with the approved remote default commit and remove the listed non-ignored untracked entries" },
      ...updates.filter(update => update.expectedOld && update.expectedOld !== update.proposed).map(update => ({
        kind: update.proposed ? "rewrite-local-ref" as const : "delete-local-ref" as const,
        ref: update.ref, description: `${update.proposed ? "Replace" : "Remove"} local branch ${update.ref.slice("refs/heads/".length)}`,
      })),
    ],
  });
  await revalidate();
  if (worktree.fingerprint !== inspection.local.files) return fail("SETUP_STATE_CHANGED", "Working files changed while preparing remote adoption. Review a new setup preview.");
  await beginOperation(repo, plan);
  await revalidate();
  await withMutationBoundary(repo, plan.operationId, "file-replacement", async () => {
    await repo.removeWorkingFiles(removedFiles, removedDirectories);
    await repo.replaceWorkingFiles(defaultTip);
  });
  await applyLocalRefTransaction(repo, plan);
  await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(inspection.remoteDefaultBranch));
  await withMutationBoundary(repo, plan.operationId, "remote-fetch", () => repo.fetchAllBranches(inspection.remote));
  const fetched = [...await snapshotRemoteTrackingTips(repo, inspection.remote)].map(([name, tip]) => ({ name, tip }));
  if (JSON.stringify(fetched) !== JSON.stringify(inspection.remoteTips)
    || await repo.readRemoteDefaultBranch(inspection.remote) !== inspection.remoteDefaultBranch) {
    return fail("REMOTE_CHANGED_DURING_ADOPTION", "The remote changed during replacement. Keep the backup and inspect the incomplete operation before a fresh setup attempt.");
  }
  const actualHeads = (await repo.listRefs("refs/heads/")).map(ref => ({ name: ref.name.slice("refs/heads/".length), tip: ref.objectId }));
  if (JSON.stringify(actualHeads) !== JSON.stringify(inspection.remoteTips)
    || await repo.currentBranch() !== inspection.remoteDefaultBranch
    || (await repo.statusPorcelain()).trim()) {
    return fail("REMOTE_ADOPTION_VERIFICATION_FAILED", "Replacement did not finish with all-branch parity and a clean default checkout. Keep the backup and inspect the incomplete operation.");
  }
  await repo.run(["diff", "--exit-code", "HEAD", "--"]);
  const after = await snapshotProject(repo.root, [".git"], signal);
  const preserved = after.entries.filter(entry => ignored.has(entry.name));
  if (JSON.stringify(protectedEntries) !== JSON.stringify(preserved)) {
    return fail("IGNORED_FILES_CHANGED", "Ignored files or their permissions changed during replacement. The operation is incomplete; use the backup for recovery.");
  }
  await withMutationBoundary(repo, plan.operationId, "remote-head", () => repo.setRemoteTrackingDefaultBranch(inspection.remote, inspection.remoteDefaultBranch));
  await withMutationBoundary(repo, plan.operationId, "configuration", async () => {
    for (const change of configuration) await repo.replaceConfigValues(change.key, change.after);
  });
  for (const change of configuration) {
    if (JSON.stringify(await repo.getConfigValues(change.key)) !== JSON.stringify(change.after)) {
      return fail("CONFIGURATION_VERIFICATION_FAILED", `Remote replacement could not verify configuration ${change.key}. Inspect the incomplete operation.`);
    }
  }
  if (await repo.currentBranch() !== inspection.remoteDefaultBranch || (await repo.statusPorcelain()).trim()) {
    return fail("REMOTE_ADOPTION_VERIFICATION_FAILED", "The checkout changed while finishing configuration. Inspect the incomplete operation before retrying.");
  }
  await completeOperation(repo, plan.operationId);
  return {
    operationId: plan.operationId, checkout: inspection.remoteDefaultBranch,
    created: names.filter(name => !localTips.has(name) && remoteTips.has(name)),
    fastForwarded: inspection.branches.filter(branch => branch.relation === "remote-ahead").map(branch => branch.name),
    replaced: names.filter(name => localTips.has(name) && remoteTips.has(name) && localTips.get(name) !== remoteTips.get(name)),
    deleted,
  };
}
