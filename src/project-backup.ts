import { randomUUID } from "crypto";
import { constants } from "fs";
import { chmod, lchmod, lstat, mkdir, open, readFile, realpath, symlink } from "fs/promises";
import * as path from "path";
import { fail, WipStreamError } from "./errors";
import { GitRepository } from "./git";
import { ProjectEntry, snapshotProject } from "./project-snapshot";
import { commandLockPath, withRepositoryCommandLock } from "./repository-safety";

export interface ProjectBackupHooks {
  readonly signal?: AbortSignal;
  readonly folderName?: string;
  readonly beforeCopyEntry?: (name: string, backupPath: string) => Promise<void>;
  readonly afterCopy?: (backupPath: string) => Promise<void>;
}

export interface ProjectBackup {
  readonly path: string;
  readonly verified: true;
  readonly fileCount: number;
}

export class ProjectBackupError extends WipStreamError {
  constructor(code: string, message: string, public readonly backupPath?: string) {
    super(code, message);
    this.name = "ProjectBackupError";
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function requireNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) return fail("CANCELLED", "Project backup was cancelled.");
}

async function requireOrdinaryGitDirectory(repo: GitRepository): Promise<void> {
  const gitDirectory = path.join(repo.root, ".git");
  const gitEntry = await lstat(gitDirectory);
  if (!gitEntry.isDirectory() || gitEntry.isSymbolicLink()
    || await realpath(await repo.commonGitDirectory()) !== await realpath(gitDirectory)) {
    return fail("EXTERNAL_GIT_STORAGE", "A complete project backup requires an ordinary clone with its Git directory inside the project.");
  }
}

async function requireSelfContainedGit(repo: GitRepository, entries: readonly ProjectEntry[]): Promise<void> {
  await requireOrdinaryGitDirectory(repo);
  const objectDirectory = path.resolve(repo.root, await repo.run(["rev-parse", "--git-path", "objects"]));
  if (!isWithin(await realpath(repo.root), await realpath(objectDirectory))) {
    return fail("EXTERNAL_GIT_STORAGE", "Git's object directory is outside the project; a folder copy cannot preserve independent history.");
  }
  const promisor = await repo.tryRun(["config", "--local", "--get-regexp", "^remote\\..*\\.promisor$"]);
  if (promisor.exitCode === 0 && /\s(true|yes|on|1)$/m.test(promisor.stdout)) {
    return fail("EXTERNAL_GIT_STORAGE", "A partial clone may depend on remote objects that are not in this folder. Use a complete ordinary clone before making a project backup.");
  }
  for (const entry of entries) {
    const filename = path.join(repo.root, entry.name);
    if (entry.kind === "file" && entry.name.endsWith("/objects/info/alternates") && (await readFile(filename, "utf8")).trim()) {
      return fail("EXTERNAL_GIT_STORAGE", `Git uses alternate object storage at ${filename}. A folder copy cannot guarantee independent history; use a self-contained ordinary clone.`);
    }
    if (entry.kind === "file" && entry.name.endsWith("/.git")) {
      const gitfile = /^gitdir: (.+)\s*$/m.exec(await readFile(filename, "utf8"))?.[1]?.trim();
      if (!gitfile || path.isAbsolute(gitfile) || !isWithin(repo.root, await realpath(path.resolve(path.dirname(filename), gitfile)))) {
        return fail("EXTERNAL_GIT_STORAGE", `Nested Git storage at ${filename} cannot be preserved as an independent folder copy.`);
      }
    }
    if (entry.kind === "link" && /(^|\/)\.git(\/|$)/.test(entry.name)) {
      const target = entry.contents as string;
      if (path.isAbsolute(target) || !isWithin(repo.root, path.resolve(path.dirname(filename), target))) {
        return fail("EXTERNAL_GIT_STORAGE", `Git storage links outside the copied project at ${filename}. A complete backup is not possible.`);
      }
    }
  }
}

async function copyRegularFile(source: string, destination: string, mode: number, signal?: AbortSignal): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(destination, "wx", 0o600);
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        requireNotCancelled(signal);
        await output.writeFile(chunk);
      }
      await output.chmod(mode);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Caller holds the command lock; the backup precedes any replacement receipt. */
export async function backupProjectUnlocked(
  repo: GitRepository,
  selectedParent: string,
  hooks: ProjectBackupHooks = {}
): Promise<ProjectBackup> {
  let backupPath: string | undefined;
  let created = false;
  try {
    requireNotCancelled(hooks.signal);
    await repo.assertSingleWorktree();
    const sourceRoot = await realpath(repo.root);
    const parent = await realpath(selectedParent);
    if (!(await lstat(parent)).isDirectory() || isWithin(sourceRoot, parent)) {
      return fail("INVALID_BACKUP_DESTINATION", "Choose an existing backup parent outside the project tree.");
    }
    const name = hooks.folderName ?? `${path.basename(repo.root)}-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    if (!name || name === "." || name === ".." || path.basename(name) !== name || /[\\/\0]/.test(name)) {
      return fail("INVALID_BACKUP_DESTINATION", "The backup must be a new child folder under the selected parent.");
    }
    backupPath = path.join(parent, name);
    const lockName = path.relative(repo.root, await commandLockPath(repo)).split(path.sep).join("/");
    const before = await snapshotProject(repo.root, [lockName], hooks.signal);
    await requireSelfContainedGit(repo, before.entries);
    // mkdir without recursive deliberately refuses an existing destination.
    await mkdir(backupPath, { mode: 0o700 });
    created = true;
    for (const entry of before.entries) {
      requireNotCancelled(hooks.signal);
      await hooks.beforeCopyEntry?.(entry.name, backupPath);
      requireNotCancelled(hooks.signal);
      if (!entry.name) continue;
      const source = path.join(repo.root, entry.name);
      const destination = path.join(backupPath, entry.name);
      if (entry.kind === "directory") {
        await mkdir(destination, { mode: 0o700 });
      } else if (entry.kind === "link") {
        await symlink(entry.contents as string, destination);
        if (((await lstat(destination)).mode & 0o7777) !== entry.mode) await lchmod(destination, entry.mode);
      } else {
        await copyRegularFile(source, destination, entry.mode, hooks.signal);
      }
    }
    // Restore directory permissions only after creating all their children.
    for (const entry of [...before.entries].reverse()) {
      if (entry.kind === "directory") await chmod(path.join(backupPath, entry.name), entry.mode);
    }
    await hooks.afterCopy?.(backupPath);
    requireNotCancelled(hooks.signal);
    const copied = await snapshotProject(backupPath, [], hooks.signal);
    const after = await snapshotProject(repo.root, [lockName], hooks.signal);
    if (before.fingerprint !== after.fingerprint || before.sourceFingerprint !== after.sourceFingerprint) {
      return fail("PROJECT_CHANGED", "The source project changed while the backup was being copied. Review the current project and retry.");
    }
    if (before.fingerprint !== copied.fingerprint) {
      return fail("BACKUP_VERIFICATION_FAILED", "Copied contents, permissions, or symbolic-link targets do not match the inspected project.");
    }
    return { path: backupPath, verified: true, fileCount: before.entries.filter(entry => entry.kind !== "directory").length };
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    const code = error instanceof WipStreamError ? error.code : (error as NodeJS.ErrnoException).code ?? "BACKUP_FAILED";
    const detail = created ? ` Incomplete backup retained at ${backupPath}. It has not been verified; no replacement is authorized by this copy.` : " No backup was created.";
    throw new ProjectBackupError(code, `${original}${detail}`, created ? backupPath : undefined);
  }
}

export async function createProjectBackup(
  repo: GitRepository,
  selectedParent: string,
  hooks: ProjectBackupHooks = {}
): Promise<ProjectBackup> {
  await requireOrdinaryGitDirectory(repo);
  return withRepositoryCommandLock(repo, "Back Up Project", () => backupProjectUnlocked(repo, selectedParent, hooks));
}
