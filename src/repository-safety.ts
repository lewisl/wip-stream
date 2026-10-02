import { randomUUID } from "crypto";
import { open, mkdir, readFile, unlink, lstat, rename } from "fs/promises";
import { hostname } from "os";
import * as path from "path";
import { errorCode, fail as failWipStream, WipStreamError } from "./errors";
import { GitRepository } from "./git";
import { inspectIncompleteOperations } from "./operations";
import { recoverExternalMerge } from "./merge-recovery";

export interface RepositoryPreflightPolicy {
  readonly command: string;
  readonly cleanWorktree: boolean;
  readonly cleanSubmodules: boolean;
  readonly refuse?: (code: string, message: string) => never;
}

export async function requireRepositoryPreflight(
  repo: GitRepository,
  policy: RepositoryPreflightPolicy
): Promise<void> {
  const { command, cleanWorktree, cleanSubmodules, refuse = failWipStream } = policy;
  await repo.assertSingleWorktree();
  if (await repo.isBare()) {
    refuse("BARE_REPOSITORY", `${command} requires a normal working repository.`);
  }
  if (await repo.isShallow()) {
    refuse("SHALLOW_REPOSITORY", `${command} requires complete repository history.`);
  }
  if (await repo.operationInProgress()) {
    refuse("GIT_OPERATION_IN_PROGRESS", `Finish or abort the active Git operation before ${command}. For a WipStream merge, use Continue Pending Merge or Abort Pending Merge.`);
  }
  if (await repo.hasConflicts()) {
    refuse("UNRESOLVED_CONFLICTS", `Resolve Git conflicts before ${command}.`);
  }
  if (cleanWorktree && (await repo.statusPorcelain()).trim()) {
    refuse("DIRTY_WORKTREE", `${command} requires a clean working tree.`);
  }
  if (cleanSubmodules && await repo.hasDirtySubmodules()) {
    refuse("DIRTY_SUBMODULES", `Commit or discard changes inside submodules before ${command}.`);
  }
  const incomplete = await inspectIncompleteOperations(repo);
  for (const receipt of incomplete) {
    refuse(
      "INCOMPLETE_WIPSTREAM_OPERATION",
      `WipStream operation “${receipt.plan.operationId}” (${receipt.plan.command}, ${receipt.phase}) is incomplete. Run WipStream: Recover Incomplete Operation to inspect it and keep your current files and commits, then retry ${command}.`
    );
  }
}

export async function recoverResolvedExternalMerges(repo: GitRepository): Promise<void> {
  for (const receipt of await inspectIncompleteOperations(repo)) await recoverExternalMerge(repo, receipt);
}

export interface CommandLockRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly command: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly repositoryRoot: string;
}

export class CommandLockError extends WipStreamError {
  public readonly lockPath: string;
  public readonly existing?: Partial<CommandLockRecord>;

  constructor(
    code: "COMMAND_IN_PROGRESS" | "STALE_COMMAND_LOCK" | "COMMAND_LOCK_CHANGED",
    message: string,
    lockPath: string,
    existing?: Partial<CommandLockRecord>
  ) {
    super(code, message);
    this.name = "CommandLockError";
    this.lockPath = lockPath;
    this.existing = existing;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isLockRecord(value: unknown): value is CommandLockRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<CommandLockRecord>;
  return record.schemaVersion === 1
    && typeof record.operationId === "string"
    && typeof record.command === "string"
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid) && record.pid > 0
    && typeof record.hostname === "string"
    && typeof record.startedAt === "string"
    && typeof record.repositoryRoot === "string";
}

async function readLock(lockPath: string): Promise<CommandLockRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    return isLockRecord(value) ? value : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function lockError(lockPath: string, existing: CommandLockRecord | undefined): CommandLockError {
  if (!existing) {
    return new CommandLockError(
      "STALE_COMMAND_LOCK",
      `WipStream found an unreadable command lock at ${lockPath}. Inspect and remove that stale lock before retrying.`,
      lockPath
    );
  }
  const detail = `command “${existing.command}”, process ${existing.pid}, started ${existing.startedAt}`;
  if (existing.hostname === hostname() && !processIsAlive(existing.pid)) {
    return new CommandLockError(
      "STALE_COMMAND_LOCK",
      `WipStream found a stale command lock at ${lockPath} (${detail}). Run Recover Incomplete Operation to inspect and reclaim it.`,
      lockPath,
      existing
    );
  }
  return new CommandLockError(
    "COMMAND_IN_PROGRESS",
    `Another WipStream command is already running (${detail}). Wait for it to finish before retrying.`,
    lockPath,
    existing
  );
}

export async function commandLockPath(repo: GitRepository): Promise<string> {
  return path.join(await repo.commonGitDirectory(), "wipstream", "command.lock");
}

const LOCK_RECOVERY_REF = "refs/wipstream/command-lock-recovery";

async function requireNoLockRecovery(repo: GitRepository): Promise<void> {
  if (await repo.objectId(LOCK_RECOVERY_REF)) {
    throw new CommandLockError("COMMAND_IN_PROGRESS", "A command-lock recovery lease exists. Run Recover Incomplete Operation if its owner was interrupted.", await commandLockPath(repo));
  }
}

/** Git's exact-old transaction serializes recovery, including after a crash. */
export async function recoverStaleCommandLock(repo: GitRepository): Promise<boolean> {
  await repo.assertSingleWorktree();
  const lockPath = await commandLockPath(repo);
  const previousLease = await repo.objectId(LOCK_RECOVERY_REF) ?? null;
  if (previousLease) {
    let owner: unknown;
    try { owner = JSON.parse(await repo.runRaw(["cat-file", "blob", previousLease])); } catch { owner = undefined; }
    if (!isLockRecord(owner) || owner.repositoryRoot !== repo.root || owner.hostname !== hostname() || processIsAlive(owner.pid)) {
      throw new CommandLockError("COMMAND_IN_PROGRESS", "The lock-recovery owner is active, on another host, or cannot be verified. Its lease was preserved for inspection.", lockPath);
    }
  }
  const owner: CommandLockRecord = {
    schemaVersion: 1, operationId: randomUUID(), command: "Recover command lock",
    pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), repositoryRoot: repo.root,
  };
  const lease = await repo.createBlob(JSON.stringify(owner));
  try {
    await repo.updateRefs([{ ref: LOCK_RECOVERY_REF, expectedOld: previousLease, proposed: lease }]);
  } catch {
    throw new CommandLockError("COMMAND_IN_PROGRESS", "Another process acquired the command-lock recovery lease. Retry recovery after it finishes.", lockPath);
  }
  try {
    let identity;
    try { identity = await lstat(lockPath); } catch (error) {
      if (errorCode(error) === "ENOENT") return previousLease !== null;
      throw error;
    }
    const existing = await readLock(lockPath);
    if (!existing || !identity.isFile() || existing.repositoryRoot !== repo.root
      || (process.getuid && identity.uid !== process.getuid())
      || existing.hostname !== hostname() || processIsAlive(existing.pid)) {
      throw lockError(lockPath, existing);
    }
    // Inspect receipts before reclaiming; corrupt recovery history must not be bypassed.
    await inspectIncompleteOperations(repo);
    const verified = await lstat(lockPath);
    if (verified.ino !== identity.ino || verified.dev !== identity.dev
      || JSON.stringify(await readLock(lockPath)) !== JSON.stringify(existing)) {
      throw new CommandLockError("COMMAND_LOCK_CHANGED", "The stale command lock changed during recovery; it was preserved.", lockPath);
    }
    await rename(lockPath, `${lockPath}.recovered-${owner.operationId}`);
    return true;
  } finally {
    await repo.updateRefs([{ ref: LOCK_RECOVERY_REF, expectedOld: lease, proposed: null }]);
  }
}

export class RepositoryCommandLock {
  private released = false;

  constructor(
    public readonly path: string,
    public readonly record: CommandLockRecord
  ) {}

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }
    let existing: CommandLockRecord | undefined;
    try {
      existing = await readLock(this.path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        this.released = true;
        return;
      }
      throw error;
    }
    if (!existing || existing.operationId !== this.record.operationId) {
      throw new CommandLockError(
        "COMMAND_LOCK_CHANGED",
        `The WipStream command lock at ${this.path} changed while “${this.record.command}” was running. It was left in place for inspection.`,
        this.path,
        existing
      );
    }
    await unlink(this.path);
    this.released = true;
  }
}

export async function acquireRepositoryCommandLock(
  repo: GitRepository,
  command: string
): Promise<RepositoryCommandLock> {
  await repo.assertSingleWorktree();
  const lockPath = await commandLockPath(repo);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const record: CommandLockRecord = {
    schemaVersion: 1,
    operationId: randomUUID(),
    command,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    repositoryRoot: repo.root,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await requireNoLockRecovery(repo);
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      const lock = new RepositoryCommandLock(lockPath, record);
      try {
        await requireNoLockRecovery(repo);
        await repo.assertSingleWorktree();
      } catch (error) {
        await lock.release();
        throw error;
      }
      return lock;
    } catch (error) {
      if (error instanceof CommandLockError || errorCode(error) !== "EEXIST") {
        throw error;
      }
      try {
        throw lockError(lockPath, await readLock(lockPath));
      } catch (readError) {
        if (errorCode(readError) === "ENOENT" && attempt === 0) {
          continue;
        }
        throw readError;
      }
    }
  }
  throw lockError(lockPath, await readLock(lockPath));
}

export async function withRepositoryCommandLock<T>(
  repo: GitRepository,
  command: string,
  action: () => Promise<T>
): Promise<T> {
  const lock = await acquireRepositoryCommandLock(repo, command);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

/** Recognize externally resolved merges under the ordinary command lock. */
export async function withRepositoryWorkflow<T>(
  repo: GitRepository,
  command: string,
  action: () => Promise<T>
): Promise<T> {
  return withRepositoryCommandLock(repo, command, async () => {
    await recoverResolvedExternalMerges(repo);
    return action();
  });
}
