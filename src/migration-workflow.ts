import { CONFIG_KEYS, REPOSITORY_CONFIG_VERSION } from "./constants";
import { GitRefUpdate, GitRemoteRefUpdate, GitRepository } from "./git";
import {
  ConfigurationTransition,
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  withMutationBoundary,
} from "./operations";
import {
  Version1RepositoryConfiguration,
  readRepositoryConfiguration,
  resolveRemoteDefaultBranch,
  snapshotRemoteTips,
} from "./repository-model";
import { withRepositoryCommandLock } from "./repository-safety";

export type Version1MigrationKind = "active" | "completed";

export interface Version1MigrationPreview {
  readonly kind: Version1MigrationKind;
  readonly remoteAlreadyMigrated: boolean;
  readonly remote: string;
  readonly mainBranch: string;
  readonly featureBranch: string;
  readonly wipBranch: string;
  readonly preservedCheckpointTip?: string;
  readonly localRefUpdates: readonly GitRefUpdate[];
  readonly remoteRefUpdates: readonly GitRemoteRefUpdate[];
  readonly configurationChanges: readonly ConfigurationTransition[];
  readonly checkout: {
    readonly before: string;
    readonly after: string;
  };
}

export interface Version1MigrationHooks {
  readonly confirmPreview?: (preview: Version1MigrationPreview) => Promise<boolean>;
  readonly beforeRemotePush?: () => Promise<void>;
  readonly afterRemotePush?: () => Promise<void>;
}

export interface Version1MigrationResult {
  readonly operationId: string;
  readonly migration: Version1MigrationKind;
  readonly remoteAlreadyMigrated: boolean;
  readonly checkout: string;
  readonly published: readonly string[];
  readonly created: readonly string[];
  readonly fastForwarded: readonly string[];
  readonly deleted: readonly string[];
}

interface PreparedMigration extends Version1MigrationPreview {
  readonly localTipsBefore: ReadonlyMap<string, string>;
  readonly fetchedRemoteTipsBefore: ReadonlyMap<string, string>;
  readonly desiredRemoteTips: ReadonlyMap<string, string>;
  readonly configurationSnapshot: ReadonlyMap<string, readonly string[]>;
}

export class MigrationWorkflowError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationWorkflowError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new MigrationWorkflowError(code, message);
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([name, tip]) => right.get(name) === tip);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function snapshotLocalTips(repo: GitRepository): Promise<ReadonlyMap<string, string>> {
  const prefix = "refs/heads/";
  return new Map((await repo.listRefs(prefix)).map((ref) => [ref.name.slice(prefix.length), ref.objectId]));
}

async function requireStableMigrationRepository(repo: GitRepository): Promise<void> {
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    fail("BARE_REPOSITORY", "Version 1 migration requires a normal working repository.");
  }
  if (await repo.isShallow()) {
    fail("SHALLOW_REPOSITORY", "Version 1 migration requires complete repository history.");
  }
  if (await repo.operationInProgress()) {
    fail("GIT_OPERATION_IN_PROGRESS", "Finish the active Git operation before migrating version 1.");
  }
  if (await repo.hasConflicts()) {
    fail("UNRESOLVED_CONFLICTS", "Resolve Git conflicts before migrating version 1.");
  }
  if ((await repo.statusPorcelain()).trim()) {
    fail("DIRTY_WORKTREE", "Version 1 migration requires a clean working tree.");
  }
  const incomplete = await inspectIncompleteOperations(repo);
  if (incomplete.length) {
    fail(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `Inspect the incomplete WipStream operation “${incomplete[0].plan.operationId}” before migrating version 1.`
    );
  }
}

async function requireValidLegacyNames(
  repo: GitRepository,
  configuration: Version1RepositoryConfiguration
): Promise<void> {
  const branches = [configuration.mainBranch, configuration.featureBranch, configuration.wipBranch];
  if (new Set(branches).size !== branches.length) {
    fail("MIGRATION_INVALID_BRANCH_NAMES", "Version 1 main, feature, and WIP branch names must be distinct.");
  }
  for (const branch of branches) {
    if (!(await repo.validateBranchName(branch))) {
      fail("MIGRATION_INVALID_BRANCH_NAMES", `Version 1 branch “${branch}” is not a valid Git branch name.`);
    }
  }
}

async function relation(
  repo: GitRepository,
  localTip: string,
  remoteTip: string
): Promise<"equal" | "local-ahead" | "remote-ahead" | "diverged"> {
  if (localTip === remoteTip) return "equal";
  if (await repo.isAncestor(localTip, remoteTip)) return "remote-ahead";
  if (await repo.isAncestor(remoteTip, localTip)) return "local-ahead";
  return "diverged";
}

async function requireTopology(repo: GitRepository, main: string, feature: string, wip: string): Promise<void> {
  if (!(await repo.isAncestor(main, feature)) || !(await repo.isAncestor(feature, wip))) {
    fail(
      "MIGRATION_INVALID_TOPOLOGY",
      "Version 1 migration requires complete main → feature → WIP ancestry. No ordinary ref was changed."
    );
  }
}

async function configurationPlan(
  repo: GitRepository,
  configuration: Version1RepositoryConfiguration,
  survivingBranches: readonly string[],
  kind: Version1MigrationKind
): Promise<{
  readonly changes: readonly ConfigurationTransition[];
  readonly snapshot: ReadonlyMap<string, readonly string[]>;
}> {
  const changes: ConfigurationTransition[] = [];
  const snapshot = new Map<string, readonly string[]>();
  const inspect = async (key: string): Promise<readonly string[]> => {
    const existing = snapshot.get(key);
    if (existing) return existing;
    const values = await repo.getConfigValues(key);
    snapshot.set(key, values);
    return values;
  };
  const change = async (key: string, after: readonly string[]): Promise<void> => {
    const before = await inspect(key);
    if (!arraysEqual(before, after)) changes.push({ key, before, after });
  };

  await change(`remote.${configuration.remote}.fetch`, [
    `+refs/heads/*:refs/remotes/${configuration.remote}/*`,
  ]);
  for (const branch of [...survivingBranches].sort()) {
    await change(`branch.${branch}.remote`, [configuration.remote]);
    await change(`branch.${branch}.merge`, [`refs/heads/${branch}`]);
  }

  if (kind === "active") {
    await change(`branch.${configuration.featureBranch}.wipstreamParent`, [configuration.mainBranch]);
  }
  for (const branch of kind === "active" ? [configuration.wipBranch] : [configuration.featureBranch, configuration.wipBranch]) {
    await change(`branch.${branch}.remote`, []);
    await change(`branch.${branch}.merge`, []);
    await change(`branch.${branch}.wipstreamParent`, []);
  }

  for (const key of [
    CONFIG_KEYS.mainBranch,
    CONFIG_KEYS.featureBranch,
    CONFIG_KEYS.wipBranch,
    CONFIG_KEYS.lastKnownRemoteWip,
  ]) {
    await change(key, []);
  }
  await change(CONFIG_KEYS.remote, [configuration.remote]);
  await change(CONFIG_KEYS.version, [REPOSITORY_CONFIG_VERSION]);

  for (const key of [
    CONFIG_KEYS.version,
    CONFIG_KEYS.remote,
    CONFIG_KEYS.mainBranch,
    CONFIG_KEYS.featureBranch,
    CONFIG_KEYS.wipBranch,
    CONFIG_KEYS.lastKnownRemoteWip,
  ]) {
    await inspect(key);
  }
  return { changes, snapshot };
}

async function prepareMigration(
  repo: GitRepository,
  configuration: Version1RepositoryConfiguration
): Promise<PreparedMigration> {
  await requireValidLegacyNames(repo, configuration);
  await repo.ensureRemote(configuration.remote);
  const currentBranch = await repo.currentBranch();
  if (!currentBranch) {
    return fail("DETACHED_HEAD", "Check out an ordinary branch before migrating version 1.");
  }

  const previousRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  await repo.fetchAllBranches(configuration.remote);
  const fetchedRemoteTips = await snapshotRemoteTips(repo, configuration.remote);
  const localTips = await snapshotLocalTips(repo);
  const remoteDefaultBranch = await resolveRemoteDefaultBranch(repo, configuration.remote);
  if (remoteDefaultBranch !== configuration.mainBranch) {
    return fail(
      "MIGRATION_DEFAULT_BRANCH_MISMATCH",
      `The remote default branch is “${remoteDefaultBranch}”, but version 1 names “${configuration.mainBranch}” as main.`
    );
  }
  const remoteMain = fetchedRemoteTips.get(configuration.mainBranch);
  const localMain = localTips.get(configuration.mainBranch);
  if (!remoteMain || !localMain) {
    return fail(
      "MIGRATION_INCOMPLETE_MAIN",
      "Version 1 migration requires the configured main branch both locally and remotely."
    );
  }
  await repo.verifyAtomicPushSupport(configuration.remote, repo.localRef(configuration.mainBranch), remoteMain);

  const remoteFeature = fetchedRemoteTips.get(configuration.featureBranch);
  const remoteWip = fetchedRemoteTips.get(configuration.wipBranch);
  const localFeature = localTips.get(configuration.featureBranch);
  const localWip = localTips.get(configuration.wipBranch);
  let kind: Version1MigrationKind;
  let remoteAlreadyMigrated = false;

  if (remoteFeature && remoteWip) {
    if (!localFeature || !localWip) {
      return fail(
        "MIGRATION_PARTIAL_LOCAL_STREAM",
        "The remote stream is active, but its complete feature and WIP pair is not present locally."
      );
    }
    if (localMain !== remoteMain || localFeature !== remoteFeature || localWip !== remoteWip) {
      return fail(
        "MIGRATION_NOT_SYNCHRONIZED",
        "Version 1 main, feature, and WIP must exactly match their fetched remote tips before migration."
      );
    }
    if (!configuration.lastKnownRemoteWip || configuration.lastKnownRemoteWip !== remoteWip) {
      return fail(
        "MIGRATION_WIP_PROOF_REQUIRED",
        "The fetched WIP tip does not match this clone’s last successful handoff, so migration cannot prove that no rewritten work would be accepted."
      );
    }
    await requireTopology(repo, remoteMain, remoteFeature, remoteWip);
    kind = "active";
  } else if (remoteFeature && !remoteWip) {
    const mainRelation = await relation(repo, localMain, remoteMain);
    if (mainRelation === "local-ahead" || mainRelation === "diverged") {
      return fail(
        "MIGRATION_ALREADY_MIGRATED_MAIN_UNSAFE",
        "The remote has the migrated feature-only shape, but local main contains work not present on remote main."
      );
    }
    if (
      !configuration.lastKnownRemoteWip
      || !(await repo.refExists(configuration.lastKnownRemoteWip))
      || !(await repo.isAncestor(configuration.lastKnownRemoteWip, remoteFeature))
    ) {
      return fail(
        "MIGRATION_ALREADY_MIGRATED_WIP_UNSAFE",
        "The surviving remote feature does not contain this clone’s last successfully handed-off WIP tip."
      );
    }
    if (!(await repo.isAncestor(localMain, remoteFeature))) {
      return fail(
        "MIGRATION_ALREADY_MIGRATED_TOPOLOGY_UNSAFE",
        "The surviving remote feature does not descend from this clone’s legacy main tip."
      );
    }
    for (const [name, tip] of [
      [configuration.featureBranch, localFeature],
      [configuration.wipBranch, localWip],
    ] as const) {
      if (tip && (!(await repo.isAncestor(localMain, tip)) || !(await repo.isAncestor(tip, remoteFeature)))) {
        return fail(
          "MIGRATION_ALREADY_MIGRATED_LOCAL_WORK_UNSAFE",
          `Local legacy branch “${name}” contains work not present on the surviving remote feature.`
        );
      }
    }
    kind = "active";
    remoteAlreadyMigrated = true;
  } else if (!remoteFeature && remoteWip) {
    return fail(
      "MIGRATION_PARTIAL_REMOTE_STREAM",
      "The remote has a WIP companion without its feature branch. No ordinary ref was changed."
    );
  } else {
    if (Boolean(localFeature) !== Boolean(localWip)) {
      return fail(
        "MIGRATION_PARTIAL_LOCAL_STREAM",
        "Exactly one local temporary version 1 branch remains. Preserve and inspect it before migration."
      );
    }
    const mainRelation = await relation(repo, localMain, remoteMain);
    if (mainRelation === "local-ahead" || mainRelation === "diverged") {
      return fail(
        "MIGRATION_COMPLETED_MAIN_UNSAFE",
        "Local main contains work not proven present on the completed remote main."
      );
    }
    for (const [name, tip] of [
      [configuration.featureBranch, localFeature],
      [configuration.wipBranch, localWip],
    ] as const) {
      if (tip && !(await repo.isAncestor(tip, remoteMain))) {
        return fail(
          "MIGRATION_LOCAL_UNFINISHED_WORK",
          `Local “${name}” contains work not present on completed remote main.`
        );
      }
    }
    kind = "completed";
  }

  const desiredRemoteTips = new Map(fetchedRemoteTips);
  const remoteRefUpdates: GitRemoteRefUpdate[] = [];
  if (kind === "active") {
    const preservedTip = remoteAlreadyMigrated ? remoteFeature as string : localWip as string;
    desiredRemoteTips.set(configuration.featureBranch, preservedTip);
    desiredRemoteTips.delete(configuration.wipBranch);
    if (!remoteAlreadyMigrated) {
      remoteRefUpdates.push(
        {
          ref: repo.localRef(configuration.featureBranch),
          expected: remoteFeature as string,
          proposed: preservedTip,
        },
        {
          ref: repo.localRef(configuration.wipBranch),
          expected: remoteWip as string,
          proposed: null,
        }
      );
    }
  }

  const localRefUpdates: GitRefUpdate[] = [];
  const names = [...new Set([...localTips.keys(), ...desiredRemoteTips.keys(), ...previousRemoteTips.keys()])].sort();
  for (const name of names) {
    const localTip = localTips.get(name);
    const desiredRemoteTip = desiredRemoteTips.get(name);
    const isRemovedLegacyBranch = name === configuration.wipBranch
      || (kind === "completed" && name === configuration.featureBranch);
    if (isRemovedLegacyBranch) {
      if (localTip) {
        localRefUpdates.push({ ref: repo.localRef(name), expectedOld: localTip, proposed: null });
      }
      continue;
    }
    if (localTip && desiredRemoteTip) {
      const branchRelation = await relation(repo, localTip, desiredRemoteTip);
      if (branchRelation === "remote-ahead") {
        localRefUpdates.push({ ref: repo.localRef(name), expectedOld: localTip, proposed: desiredRemoteTip });
      } else if (branchRelation === "local-ahead") {
        remoteRefUpdates.push({ ref: repo.localRef(name), expected: desiredRemoteTip, proposed: localTip });
        desiredRemoteTips.set(name, localTip);
      } else if (branchRelation === "diverged") {
        return fail(
          "MIGRATION_DIVERGED_BRANCH",
          `Local and remote “${name}” diverged. Version 1 migration changed no ordinary ref.`
        );
      }
      continue;
    }
    if (localTip && !desiredRemoteTip) {
      const previousRemoteTip = previousRemoteTips.get(name);
      if (previousRemoteTip) {
        if (previousRemoteTip !== localTip) {
          return fail(
            "MIGRATION_AMBIGUOUS_DELETION",
            `Remote “${name}” was deleted after local work changed. Preserve and reconcile it before migration.`
          );
        }
        localRefUpdates.push({ ref: repo.localRef(name), expectedOld: localTip, proposed: null });
      } else {
        remoteRefUpdates.push({ ref: repo.localRef(name), expected: null, proposed: localTip });
        desiredRemoteTips.set(name, localTip);
      }
      continue;
    }
    if (!localTip && desiredRemoteTip) {
      localRefUpdates.push({ ref: repo.localRef(name), expectedOld: null, proposed: desiredRemoteTip });
    }
  }

  const survivingBranches = [...desiredRemoteTips.keys()].sort();
  const config = await configurationPlan(repo, configuration, survivingBranches, kind);
  return {
    kind,
    remoteAlreadyMigrated,
    remote: configuration.remote,
    mainBranch: configuration.mainBranch,
    featureBranch: configuration.featureBranch,
    wipBranch: configuration.wipBranch,
    ...(kind === "active" ? { preservedCheckpointTip: localWip as string } : {}),
    localRefUpdates,
    remoteRefUpdates,
    configurationChanges: config.changes,
    checkout: { before: currentBranch, after: remoteDefaultBranch },
    localTipsBefore: localTips,
    fetchedRemoteTipsBefore: fetchedRemoteTips,
    desiredRemoteTips,
    configurationSnapshot: config.snapshot,
  };
}

async function requirePreparedStateUnchanged(repo: GitRepository, prepared: PreparedMigration): Promise<void> {
  if (
    (await repo.currentBranch()) !== prepared.checkout.before
    || (await repo.statusPorcelain()).trim()
    || !mapsEqual(prepared.localTipsBefore, await snapshotLocalTips(repo))
    || !mapsEqual(prepared.fetchedRemoteTipsBefore, await snapshotRemoteTips(repo, prepared.remote))
  ) {
    fail(
      "MIGRATION_STATE_CHANGED",
      "The checkout, working tree, or branch tips changed after migration was previewed. Run Initialize Repository again."
    );
  }
  for (const [key, values] of prepared.configurationSnapshot) {
    if (!arraysEqual(values, await repo.getConfigValues(key))) {
      fail("MIGRATION_CONFIG_CHANGED", `Configuration “${key}” changed after migration was previewed.`);
    }
  }
}

export async function previewVersion1Migration(repo: GitRepository): Promise<Version1MigrationPreview> {
  return withRepositoryCommandLock(repo, "Preview Version 1 Migration", async () => {
    await requireStableMigrationRepository(repo);
    const configuration = await readRepositoryConfiguration(repo);
    if (configuration.kind !== "version1") {
      return fail("VERSION_1_REQUIRED", "This repository does not have version 1 configuration to migrate.");
    }
    return prepareMigration(repo, configuration);
  });
}

export async function migrateVersion1Repository(
  repo: GitRepository,
  hooks: Version1MigrationHooks = {}
): Promise<Version1MigrationResult> {
  return withRepositoryCommandLock(repo, "Migrate Version 1", () =>
    migrateVersion1RepositoryUnlocked(repo, hooks)
  );
}

export async function migrateVersion1RepositoryUnlocked(
  repo: GitRepository,
  hooks: Version1MigrationHooks = {}
): Promise<Version1MigrationResult> {
  await requireStableMigrationRepository(repo);
  const readConfiguration = await readRepositoryConfiguration(repo);
  if (readConfiguration.kind !== "version1") {
    return fail("VERSION_1_REQUIRED", "This repository does not have version 1 configuration to migrate.");
  }
  const prepared = await prepareMigration(repo, readConfiguration);
  if (hooks.confirmPreview && !(await hooks.confirmPreview(prepared))) {
    return fail("MIGRATION_CANCELLED", "Version 1 migration was cancelled before any ordinary ref changed.");
  }

  await repo.fetchAllBranches(prepared.remote);
  await requirePreparedStateUnchanged(repo, prepared);
  const plan = createOperationPlan({
    command: "Migrate Version 1",
    localRefUpdates: prepared.localRefUpdates,
    remoteRefUpdates: prepared.remoteRefUpdates.map((update) => ({ ref: update.ref, proposed: update.proposed })),
    remoteLeases: prepared.remoteRefUpdates.map((update) => ({ ref: update.ref, expected: update.expected })),
    configurationChanges: prepared.configurationChanges,
    checkout: prepared.checkout,
    destructiveEffects: [
      ...prepared.localRefUpdates.filter((update) => update.proposed === null).map((update) => ({
        kind: "delete-local-ref" as const,
        ref: update.ref,
        description: `Remove legacy or safely deleted local branch ${update.ref}`,
      })),
      ...prepared.remoteRefUpdates.filter((update) => update.proposed === null).map((update) => ({
        kind: "delete-remote-ref" as const,
        ref: update.ref,
        description: `Remove legacy or safely deleted remote branch ${update.ref}`,
      })),
      ...prepared.remoteRefUpdates.filter(
        (update) => update.expected !== null && update.proposed !== null && update.expected !== update.proposed
      ).map((update) => ({
        kind: "rewrite-remote-ref" as const,
        ref: update.ref,
        description: `Advance ${update.ref} to its preserved version 1 WIP or local tip`,
      })),
      ...(prepared.checkout.before !== prepared.checkout.after ? [{
        kind: "replace-checkout" as const,
        ref: repo.localRef(prepared.checkout.before),
        description: `Replace checkout ${prepared.checkout.before} with ${prepared.checkout.after}`,
      }] : []),
    ],
  });
  await beginOperation(repo, plan);

  if (prepared.remoteRefUpdates.length) {
    await hooks.beforeRemotePush?.();
    await withMutationBoundary(repo, plan.operationId, "remote-push", () =>
      repo.pushRefsAtomic(prepared.remote, prepared.remoteRefUpdates)
    );
    await hooks.afterRemotePush?.();
    await withMutationBoundary(repo, plan.operationId, "remote-fetch", () => repo.fetchAllBranches(prepared.remote));
    if (!mapsEqual(prepared.desiredRemoteTips, await snapshotRemoteTips(repo, prepared.remote))) {
      return fail(
        "MIGRATION_REMOTE_POSTCONDITION_FAILED",
        "The atomic migration push completed, but the fetched remote branch set is not the planned after-state."
      );
    }
  }

  if (!mapsEqual(prepared.localTipsBefore, await snapshotLocalTips(repo))) {
    return fail(
      "MIGRATION_LOCAL_STATE_CHANGED",
      "Local branches changed after the remote migration boundary. Inspect the incomplete receipt before recovery."
    );
  }
  const currentBranch = await repo.currentBranch();
  const currentWillChange = currentBranch
    ? prepared.localRefUpdates.some((update) => update.ref === repo.localRef(currentBranch))
    : false;
  if (currentWillChange) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.detach());
  }
  if (prepared.localRefUpdates.length) {
    await applyLocalRefTransaction(repo, plan);
  }
  if (currentWillChange || prepared.checkout.before !== prepared.checkout.after) {
    await withMutationBoundary(repo, plan.operationId, "checkout", () => repo.switch(prepared.checkout.after));
  }

  if (!mapsEqual(prepared.desiredRemoteTips, await snapshotLocalTips(repo))) {
    return fail(
      "MIGRATION_LOCAL_POSTCONDITION_FAILED",
      "Version 1 migration did not establish complete local and fetched-remote branch parity."
    );
  }
  if (prepared.configurationChanges.length) {
    await withMutationBoundary(repo, plan.operationId, "configuration", async () => {
      for (const change of prepared.configurationChanges) {
        await repo.replaceConfigValues(change.key, change.after);
      }
    });
  }
  const migratedConfiguration = await readRepositoryConfiguration(repo);
  if (migratedConfiguration.kind !== "version2" || migratedConfiguration.remote !== prepared.remote) {
    return fail("MIGRATION_CONFIG_POSTCONDITION_FAILED", "Version 2 configuration was not written completely.");
  }
  await completeOperation(repo, plan.operationId);

  const created = prepared.localRefUpdates
    .filter((update) => update.expectedOld === null && update.proposed !== null)
    .map((update) => update.ref.slice("refs/heads/".length));
  const deleted = prepared.localRefUpdates
    .filter((update) => update.proposed === null)
    .map((update) => update.ref.slice("refs/heads/".length));
  const fastForwarded: string[] = [];
  for (const update of prepared.localRefUpdates) {
    if (
      update.expectedOld !== null
      && update.proposed !== null
      && update.expectedOld !== update.proposed
      && await repo.isAncestor(update.expectedOld, update.proposed)
    ) {
      fastForwarded.push(update.ref.slice("refs/heads/".length));
    }
  }
  return {
    operationId: plan.operationId,
    migration: prepared.kind,
    remoteAlreadyMigrated: prepared.remoteAlreadyMigrated,
    checkout: prepared.checkout.after,
    published: prepared.remoteRefUpdates
      .filter((update) => update.proposed !== null)
      .map((update) => update.ref.slice("refs/heads/".length)),
    created,
    fastForwarded,
    deleted,
  };
}
