import { randomUUID } from "crypto";
import { open, mkdir, readFile, unlink } from "fs/promises";
import { hostname } from "os";
import * as path from "path";
import { GitRepository } from "./git";

export interface CommandLockRecord {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly command: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly repositoryRoot: string;
}

export class CommandLockError extends Error {
  public readonly code: "COMMAND_IN_PROGRESS" | "STALE_COMMAND_LOCK" | "COMMAND_LOCK_CHANGED";
  public readonly lockPath: string;
  public readonly existing?: Partial<CommandLockRecord>;

  constructor(
    code: "COMMAND_IN_PROGRESS" | "STALE_COMMAND_LOCK" | "COMMAND_LOCK_CHANGED",
    message: string,
    lockPath: string,
    existing?: Partial<CommandLockRecord>
  ) {
    super(message);
    this.name = "CommandLockError";
    this.code = code;
    this.lockPath = lockPath;
    this.existing = existing;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
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
      `WipStream found a stale command lock at ${lockPath} (${detail}). Inspect the interrupted operation before removing the lock.`,
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
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      const lock = new RepositoryCommandLock(lockPath, record);
      try {
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
