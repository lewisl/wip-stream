import { randomUUID } from "crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "fs/promises";
import * as path from "path";
import { fail, WipStreamError } from "./errors";
import { GitRefUpdate, GitRemoteRefUpdate, GitRepository } from "./git";

export type DestructiveEffectKind =
  | "delete-local-ref"
  | "delete-remote-ref"
  | "rewrite-local-ref"
  | "rewrite-remote-ref"
  | "replace-checkout";

export interface CheckoutTransition {
  readonly before?: string;
  readonly after?: string;
}

export interface CheckpointTransition {
  readonly branch: string;
  readonly before: string;
  readonly after: string;
  readonly message: string;
}

export interface ConfigurationTransition {
  readonly key: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface OperationOutcome {
  readonly additionalLocalRefUpdates: readonly GitRefUpdate[];
  readonly completedLocalRefs?: readonly { readonly ref: string; readonly objectId: string }[];
  readonly completedRemoteRefs?: readonly { readonly ref: string; readonly objectId: string }[];
  readonly completedCheckout?: string;
  readonly completedStatus?: string;
}

export interface DestructiveEffect {
  readonly kind: DestructiveEffectKind;
  readonly ref?: string;
  readonly description: string;
}

export interface OperationPlan {
  readonly schemaVersion: 2;
  readonly operationId: string;
  readonly command: string;
  readonly createdAt: string;
  readonly localRefUpdates: readonly GitRefUpdate[];
  readonly remoteRefUpdates: readonly GitRemoteRefUpdate[];
  readonly checkpoint?: Readonly<CheckpointTransition>;
  readonly configurationChanges: readonly Readonly<ConfigurationTransition>[];
  readonly checkout: Readonly<CheckoutTransition>;
  readonly destructiveEffects: readonly DestructiveEffect[];
}

export interface OperationPlanInput {
  readonly operationId?: string;
  readonly command: string;
  readonly createdAt?: string;
  readonly localRefUpdates?: readonly GitRefUpdate[];
  readonly remoteRefUpdates?: readonly GitRemoteRefUpdate[];
  readonly checkpoint?: CheckpointTransition;
  readonly configurationChanges?: readonly ConfigurationTransition[];
  readonly checkout?: CheckoutTransition;
  readonly destructiveEffects?: readonly DestructiveEffect[];
}

export type MutationBoundary =
  | "local-refs"
  | "remote-push"
  | "remote-fetch"
  | "checkout"
  | "configuration"
  | "merge";
export type TerminalOperationPhase = "completed" | "aborted" | "undone";
export type OperationPhase = "planned" | `before-${MutationBoundary}` | `after-${MutationBoundary}` | TerminalOperationPhase;
export type OperationStatus = "planned" | "in-progress" | "completed" | "aborted" | "undone";

export interface PendingMerge {
  readonly kind: "merge";
  readonly command: "Update from Parent" | "Reconcile with Remote";
  readonly branch: string;
  readonly mergeTarget: string;
  readonly preHead: string;
  readonly preIndexTree: string;
  readonly preStatus: string;
  readonly conflicts: readonly string[];
}

export interface OperationReceiptEvent {
  readonly phase: OperationPhase;
  readonly recordedAt: string;
}

export interface OperationReceipt {
  readonly schemaVersion: 1;
  readonly plan: OperationPlan;
  readonly phase: OperationPhase;
  readonly status: OperationStatus;
  readonly events: readonly OperationReceiptEvent[];
  readonly pendingMerge?: Readonly<PendingMerge>;
  readonly outcome?: Readonly<OperationOutcome>;
  readonly completedAt?: string;
}

export { WipStreamError as OperationError };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function validOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId);
}

function immutableEntries<T extends object>(entries: readonly T[] | undefined): readonly Readonly<T>[] {
  return Object.freeze((entries ?? []).map((entry) => Object.freeze({ ...entry })));
}

export function createOperationPlan(input: OperationPlanInput): OperationPlan {
  const operationId = input.operationId ?? randomUUID();
  if (!validOperationId(operationId)) {
    return fail("INVALID_OPERATION_ID", "A WipStream operation id must be a ref-safe identifier.");
  }
  if (!input.command.trim()) {
    return fail("INVALID_OPERATION_PLAN", "A WipStream operation plan must name its command.");
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    operationId,
    command: input.command,
    createdAt: input.createdAt ?? new Date().toISOString(),
    localRefUpdates: immutableEntries(input.localRefUpdates),
    remoteRefUpdates: immutableEntries(input.remoteRefUpdates),
    ...(input.checkpoint ? { checkpoint: Object.freeze({ ...input.checkpoint }) } : {}),
    configurationChanges: Object.freeze((input.configurationChanges ?? []).map((change) => Object.freeze({
      key: change.key,
      before: Object.freeze([...change.before]),
      after: Object.freeze([...change.after]),
    }))),
    checkout: Object.freeze({ ...(input.checkout ?? {}) }),
    destructiveEffects: immutableEntries(input.destructiveEffects),
  });
}

export function recoveryRef(operationId: string, ordinal: number): string {
  if (!validOperationId(operationId) || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    return fail("INVALID_RECOVERY_REF", "WipStream could not create a safe recovery ref name.");
  }
  return `refs/wipstream/recovery/${operationId}/${ordinal.toString().padStart(4, "0")}`;
}

export function localTransactionUpdates(plan: OperationPlan): readonly GitRefUpdate[] {
  const recoveryUpdates = plan.localRefUpdates.flatMap((update, ordinal) =>
    update.expectedOld !== null && update.expectedOld !== update.proposed
      ? [{ ref: recoveryRef(plan.operationId, ordinal), expectedOld: null, proposed: update.expectedOld }]
      : []
  );
  return Object.freeze([...recoveryUpdates, ...plan.localRefUpdates]);
}

export function renderOperationPreview(plan: OperationPlan): string {
  const lines = [`WipStream: ${plan.command}`, `Operation: ${plan.operationId}`];
  if (plan.checkpoint) {
    lines.push(
      `Checkpoint: ${plan.checkpoint.branch} ${plan.checkpoint.before} → ${plan.checkpoint.after}`,
      `Message: ${plan.checkpoint.message}`
    );
  }
  if (plan.checkout.before || plan.checkout.after) {
    lines.push(`Checkout: ${plan.checkout.before ?? "detached"} → ${plan.checkout.after ?? "detached"}`);
  }
  if (plan.localRefUpdates.length) {
    lines.push("Local refs:");
    for (const update of plan.localRefUpdates) {
      lines.push(`  ${update.ref}: ${update.expectedOld ?? "absent"} → ${update.proposed ?? "deleted"}`);
    }
  }
  if (plan.remoteRefUpdates.length) {
    lines.push("Remote refs:");
    for (const update of plan.remoteRefUpdates) {
      lines.push(
        `  ${update.ref}: → ${update.proposed ?? "deleted"} (lease ${update.expected ?? "must not exist"})`
      );
    }
  }
  if (plan.destructiveEffects.length) {
    lines.push("Destructive effects:");
    for (const effect of plan.destructiveEffects) {
      lines.push(`  ${effect.description}${effect.ref ? ` (${effect.ref})` : ""}`);
    }
  }
  const recoveryCount = localTransactionUpdates(plan).length - plan.localRefUpdates.length;
  if (recoveryCount) {
    lines.push(`Recovery snapshots: ${recoveryCount}`);
  }
  return lines.join("\n");
}

export async function operationReceiptDirectory(repo: GitRepository): Promise<string> {
  return path.join(await repo.commonGitDirectory(), "wipstream", "operations");
}

export async function operationReceiptPath(repo: GitRepository, operationId: string): Promise<string> {
  if (!validOperationId(operationId)) {
    return fail("INVALID_OPERATION_ID", "A WipStream operation id must be a ref-safe identifier.");
  }
  return path.join(await operationReceiptDirectory(repo), `${operationId}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isObjectIdOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizeRemoteRefUpdates(plan: Record<string, unknown>): readonly GitRemoteRefUpdate[] | undefined {
  if (!Array.isArray(plan.remoteRefUpdates)) {
    return undefined;
  }
  const updates = plan.remoteRefUpdates;
  const seen = new Set<string>();
  if (plan.schemaVersion === 2) {
    const normalized: GitRemoteRefUpdate[] = [];
    for (const update of updates) {
      if (!isObject(update)
        || typeof update.ref !== "string"
        || seen.has(update.ref)
        || !isObjectIdOrNull(update.expected)
        || !isObjectIdOrNull(update.proposed)) {
        return undefined;
      }
      seen.add(update.ref);
      normalized.push({ ref: update.ref, expected: update.expected, proposed: update.proposed });
    }
    return normalized;
  }
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.remoteLeases)) {
    return undefined;
  }
  const leases = new Map<string, string | null>();
  for (const lease of plan.remoteLeases) {
    if (!isObject(lease)
      || typeof lease.ref !== "string"
      || leases.has(lease.ref)
      || !isObjectIdOrNull(lease.expected)) {
      return undefined;
    }
    leases.set(lease.ref, lease.expected);
  }
  const normalized: GitRemoteRefUpdate[] = [];
  for (const update of updates) {
    if (!isObject(update)
      || typeof update.ref !== "string"
      || seen.has(update.ref)
      || !isObjectIdOrNull(update.proposed)
      || !leases.has(update.ref)) {
      return undefined;
    }
    seen.add(update.ref);
    normalized.push({
      ref: update.ref,
      expected: leases.get(update.ref) as string | null,
      proposed: update.proposed,
    });
  }
  return leases.size === normalized.length ? normalized : undefined;
}

function normalizeOperationPlan(value: unknown): OperationPlan | undefined {
  if (!isObject(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || typeof value.operationId !== "string"
    || !validOperationId(value.operationId)
    || typeof value.command !== "string"
    || !value.command.trim()
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.localRefUpdates)
    || !Array.isArray(value.configurationChanges)
    || !isObject(value.checkout)
    || !Array.isArray(value.destructiveEffects)
    || (value.checkpoint !== undefined && !isObject(value.checkpoint))) {
    return undefined;
  }
  const remoteRefUpdates = normalizeRemoteRefUpdates(value);
  if (!remoteRefUpdates) {
    return undefined;
  }
  try {
    return createOperationPlan({
      operationId: value.operationId,
      command: value.command,
      createdAt: value.createdAt,
      localRefUpdates: value.localRefUpdates as unknown as readonly GitRefUpdate[],
      remoteRefUpdates,
      checkpoint: value.checkpoint as unknown as CheckpointTransition | undefined,
      configurationChanges: value.configurationChanges as unknown as readonly ConfigurationTransition[],
      checkout: value.checkout as unknown as CheckoutTransition,
      destructiveEffects: value.destructiveEffects as unknown as readonly DestructiveEffect[],
    });
  } catch {
    return undefined;
  }
}

function normalizeOperationReceipt(value: unknown): OperationReceipt | undefined {
  if (!isObject(value)
    || value.schemaVersion !== 1
    || typeof value.phase !== "string"
    || !["planned", "in-progress", "completed", "aborted", "undone"].includes(String(value.status))
    || !Array.isArray(value.events)) {
    return undefined;
  }
  const plan = normalizeOperationPlan(value.plan);
  if (!plan) {
    return undefined;
  }
  return Object.freeze({ ...value, plan }) as unknown as OperationReceipt;
}

async function writeReceipt(receiptPath: string, receipt: OperationReceipt, createOnly: boolean): Promise<void> {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.tmp-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (createOnly) {
      await link(temporaryPath, receiptPath);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, receiptPath);
    }
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The rename path no longer exists, or cleanup is best-effort after the original failure.
    }
    throw error;
  }
}

export async function readOperationReceipt(repo: GitRepository, operationId: string): Promise<OperationReceipt> {
  const receiptPath = await operationReceiptPath(repo, operationId);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    return fail("INVALID_OPERATION_RECEIPT", `WipStream could not read operation receipt ${receiptPath}: ${error}`);
  }
  const receipt = normalizeOperationReceipt(value);
  if (!receipt || receipt.plan.operationId !== operationId) {
    return fail("INVALID_OPERATION_RECEIPT", `WipStream operation receipt ${receiptPath} is invalid.`);
  }
  return receipt;
}

export async function beginOperation(repo: GitRepository, plan: OperationPlan): Promise<OperationReceipt> {
  const recordedAt = new Date().toISOString();
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    plan,
    phase: "planned",
    status: "planned",
    events: [{ phase: "planned", recordedAt }],
  };
  try {
    await writeReceipt(await operationReceiptPath(repo, plan.operationId), receipt, true);
  } catch (error) {
    const code = errorCode(error) === "EEXIST" ? "OPERATION_RECEIPT_EXISTS" : "OPERATION_RECEIPT_WRITE_FAILED";
    return fail(code, `WipStream could not create a new receipt for ${plan.operationId}: ${error}`);
  }
  return receipt;
}

function phaseCanFollow(current: OperationPhase, next: OperationPhase): boolean {
  if (next === "completed") {
    return current === "planned" || current.startsWith("after-");
  }
  if (next.startsWith("before-")) {
    return current === "planned" || current.startsWith("after-");
  }
  return next.startsWith("after-") && current === next.replace(/^after-/, "before-");
}

export async function recordOperationPhase(
  repo: GitRepository,
  operationId: string,
  phase: OperationPhase
): Promise<OperationReceipt> {
  const receipt = await readOperationReceipt(repo, operationId);
  if (receipt.status === "completed") {
    return fail("OPERATION_ALREADY_COMPLETED", `WipStream operation ${operationId} is already complete.`);
  }
  if (!phaseCanFollow(receipt.phase, phase)) {
    return fail(
      "INVALID_OPERATION_PHASE",
      `WipStream operation ${operationId} cannot advance from “${receipt.phase}” to “${phase}”.`
    );
  }
  const recordedAt = new Date().toISOString();
  const updated: OperationReceipt = {
    ...receipt,
    phase,
    status: phase === "completed" ? "completed" : "in-progress",
    events: [...receipt.events, { phase, recordedAt }],
    completedAt: phase === "completed" ? recordedAt : undefined,
  };
  await writeReceipt(await operationReceiptPath(repo, operationId), updated, false);
  return updated;
}

export async function recordPendingMerge(
  repo: GitRepository,
  operationId: string,
  pendingMerge: PendingMerge
): Promise<OperationReceipt> {
  const receipt = await readOperationReceipt(repo, operationId);
  if (receipt.status !== "in-progress" || receipt.phase !== "before-merge") {
    return fail(
      "INVALID_PENDING_MERGE",
      `WipStream operation ${operationId} is not waiting inside a merge boundary.`
    );
  }
  const updated: OperationReceipt = {
    ...receipt,
    pendingMerge: Object.freeze({ ...pendingMerge, conflicts: Object.freeze([...pendingMerge.conflicts]) }),
  };
  await writeReceipt(await operationReceiptPath(repo, operationId), updated, false);
  return updated;
}

export async function recordOperationOutcome(
  repo: GitRepository,
  operationId: string,
  outcome: OperationOutcome
): Promise<OperationReceipt> {
  const receipt = await readOperationReceipt(repo, operationId);
  if (receipt.status !== "planned" && receipt.status !== "in-progress") {
    return fail("OPERATION_NOT_IN_PROGRESS", `WipStream operation ${operationId} is not active.`);
  }
  const updated: OperationReceipt = {
    ...receipt,
    outcome: Object.freeze({
      ...receipt.outcome,
      additionalLocalRefUpdates: immutableEntries(outcome.additionalLocalRefUpdates),
      ...(outcome.completedLocalRefs ? { completedLocalRefs: immutableEntries(outcome.completedLocalRefs) } : {}),
      ...(outcome.completedRemoteRefs ? { completedRemoteRefs: immutableEntries(outcome.completedRemoteRefs) } : {}),
      ...(outcome.completedCheckout !== undefined ? { completedCheckout: outcome.completedCheckout } : {}),
      ...(outcome.completedStatus !== undefined ? { completedStatus: outcome.completedStatus } : {}),
    }),
  };
  await writeReceipt(await operationReceiptPath(repo, operationId), updated, false);
  return updated;
}

export async function abortOperation(repo: GitRepository, operationId: string): Promise<OperationReceipt> {
  const receipt = await readOperationReceipt(repo, operationId);
  if (receipt.status !== "in-progress") {
    return fail("OPERATION_NOT_IN_PROGRESS", `WipStream operation ${operationId} is not in progress.`);
  }
  const recordedAt = new Date().toISOString();
  const updated: OperationReceipt = {
    ...receipt,
    phase: "aborted",
    status: "aborted",
    events: [...receipt.events, { phase: "aborted", recordedAt }],
    completedAt: recordedAt,
  };
  await writeReceipt(await operationReceiptPath(repo, operationId), updated, false);
  return updated;
}

export async function markOperationUndone(repo: GitRepository, operationId: string): Promise<OperationReceipt> {
  const receipt = await readOperationReceipt(repo, operationId);
  if (receipt.status !== "completed") {
    return fail("OPERATION_NOT_COMPLETED", `WipStream operation ${operationId} is not completed.`);
  }
  const recordedAt = new Date().toISOString();
  const updated: OperationReceipt = {
    ...receipt,
    phase: "undone",
    status: "undone",
    events: [...receipt.events, { phase: "undone", recordedAt }],
  };
  await writeReceipt(await operationReceiptPath(repo, operationId), updated, false);
  return updated;
}

export async function withMutationBoundary<T>(
  repo: GitRepository,
  operationId: string,
  boundary: MutationBoundary,
  action: () => Promise<T>
): Promise<T> {
  await recordOperationPhase(repo, operationId, `before-${boundary}`);
  const result = await action();
  await recordOperationPhase(repo, operationId, `after-${boundary}`);
  return result;
}

export async function applyLocalRefTransaction(repo: GitRepository, plan: OperationPlan): Promise<void> {
  await withMutationBoundary(repo, plan.operationId, "local-refs", () => repo.updateRefs(localTransactionUpdates(plan)));
}

export async function listOperationReceipts(repo: GitRepository): Promise<readonly OperationReceipt[]> {
  const directory = await operationReceiptDirectory(repo);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const receipts: OperationReceipt[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    receipts.push(await readOperationReceipt(repo, name.slice(0, -5)));
  }
  return receipts;
}

export async function inspectIncompleteOperations(repo: GitRepository): Promise<readonly OperationReceipt[]> {
  return (await listOperationReceipts(repo)).filter(
    (receipt) => receipt.status === "planned" || receipt.status === "in-progress"
  );
}

export async function pruneCompletedReceipts(repo: GitRepository, retainCompleted = 50): Promise<void> {
  if (!Number.isSafeInteger(retainCompleted) || retainCompleted < 0) {
    return fail("INVALID_RECEIPT_RETENTION", "Completed receipt retention must be a non-negative integer.");
  }
  const completed = (await listOperationReceipts(repo))
    .filter((receipt) => receipt.status === "completed")
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  for (const receipt of completed.slice(retainCompleted)) {
    await unlink(await operationReceiptPath(repo, receipt.plan.operationId));
  }
}

export async function completeOperation(
  repo: GitRepository,
  operationId: string,
  retainCompleted = 50
): Promise<OperationReceipt> {
  const receiptBeforeCompletion = await readOperationReceipt(repo, operationId);
  await recordOperationOutcome(repo, operationId, {
    additionalLocalRefUpdates: receiptBeforeCompletion.outcome?.additionalLocalRefUpdates ?? [],
    completedLocalRefs: (await repo.listRefs("refs/heads/"))
      .map((ref) => ({ ref: ref.name, objectId: ref.objectId })),
    completedRemoteRefs: (await repo.listRefs("refs/remotes/"))
      .filter((ref) => !ref.name.endsWith("/HEAD"))
      .map((ref) => ({ ref: ref.name, objectId: ref.objectId })),
    completedCheckout: await repo.currentBranch(),
    completedStatus: await repo.statusPorcelain(),
  });
  const receipt = await recordOperationPhase(repo, operationId, "completed");
  await pruneCompletedReceipts(repo, retainCompleted);
  return receipt;
}
