import { randomUUID } from "crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "fs/promises";
import * as path from "path";
import { GitRefUpdate, GitRepository } from "./git";

export type DestructiveEffectKind =
  | "delete-local-ref"
  | "delete-remote-ref"
  | "rewrite-local-ref"
  | "rewrite-remote-ref"
  | "replace-checkout";

export interface RemoteRefUpdate {
  readonly ref: string;
  readonly proposed: string | null;
}

export interface RemoteLease {
  readonly ref: string;
  readonly expected: string | null;
}

export interface CheckoutTransition {
  readonly before?: string;
  readonly after?: string;
}

export interface DestructiveEffect {
  readonly kind: DestructiveEffectKind;
  readonly ref?: string;
  readonly description: string;
}

export interface OperationPlan {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly command: string;
  readonly createdAt: string;
  readonly localRefUpdates: readonly GitRefUpdate[];
  readonly remoteRefUpdates: readonly RemoteRefUpdate[];
  readonly remoteLeases: readonly RemoteLease[];
  readonly checkout: Readonly<CheckoutTransition>;
  readonly destructiveEffects: readonly DestructiveEffect[];
}

export interface OperationPlanInput {
  readonly operationId?: string;
  readonly command: string;
  readonly createdAt?: string;
  readonly localRefUpdates?: readonly GitRefUpdate[];
  readonly remoteRefUpdates?: readonly RemoteRefUpdate[];
  readonly remoteLeases?: readonly RemoteLease[];
  readonly checkout?: CheckoutTransition;
  readonly destructiveEffects?: readonly DestructiveEffect[];
}

export type MutationBoundary = "local-refs" | "remote-push" | "checkout" | "configuration";
export type OperationPhase = "planned" | `before-${MutationBoundary}` | `after-${MutationBoundary}` | "completed";
export type OperationStatus = "planned" | "in-progress" | "completed";

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
  readonly completedAt?: string;
}

export class OperationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OperationError(code, message);
}

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
    schemaVersion: 1 as const,
    operationId,
    command: input.command,
    createdAt: input.createdAt ?? new Date().toISOString(),
    localRefUpdates: immutableEntries(input.localRefUpdates),
    remoteRefUpdates: immutableEntries(input.remoteRefUpdates),
    remoteLeases: immutableEntries(input.remoteLeases),
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
      const lease = plan.remoteLeases.find((candidate) => candidate.ref === update.ref);
      lines.push(
        `  ${update.ref}: → ${update.proposed ?? "deleted"} (lease ${lease ? lease.expected ?? "must not exist" : "missing"})`
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

function isOperationReceipt(value: unknown): value is OperationReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const receipt = value as Partial<OperationReceipt>;
  return receipt.schemaVersion === 1
    && typeof receipt.plan === "object"
    && receipt.plan !== null
    && typeof receipt.plan.operationId === "string"
    && typeof receipt.phase === "string"
    && ["planned", "in-progress", "completed"].includes(String(receipt.status))
    && Array.isArray(receipt.events);
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
  if (!isOperationReceipt(value) || value.plan.operationId !== operationId) {
    return fail("INVALID_OPERATION_RECEIPT", `WipStream operation receipt ${receiptPath} is invalid.`);
  }
  return value;
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
  return (await listOperationReceipts(repo)).filter((receipt) => receipt.status !== "completed");
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
  const receipt = await recordOperationPhase(repo, operationId, "completed");
  await pruneCompletedReceipts(repo, retainCompleted);
  return receipt;
}
