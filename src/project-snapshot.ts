import { createHash } from "crypto";
import { constants } from "fs";
import { lstat, open, readdir, readlink } from "fs/promises";
import * as path from "path";
import { fail } from "./errors";
import { GitRepository } from "./git";

export interface WorkingFilesSnapshot {
  readonly fingerprint: string;
  readonly filesRead: number;
  readonly bytesRead: number;
}

/** Snapshot Git-visible work without traversing ignored directories. */
export async function snapshotWorkingFiles(repo: GitRepository, signal?: AbortSignal): Promise<WorkingFilesSnapshot> {
  const names = await repo.workingFileNames();
  const entries: unknown[] = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const name of names) {
    if (signal?.aborted) return fail("CANCELLED", "Working-file inspection was cancelled.");
    const filename = path.join(repo.root, name);
    let before;
    try {
      // A replaced parent link makes old tracked children absent in the checkout.
      let blockedParent = false;
      for (let parent = path.dirname(name); parent !== "."; parent = path.dirname(parent)) {
        if (!(await lstat(path.join(repo.root, parent))).isDirectory()) { blockedParent = true; break; }
      }
      if (!blockedParent) before = await lstat(filename);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (!before) { entries.push([name, "absent"]); continue; }
    const mode = before.mode & 0o7777;
    if (before.isSymbolicLink()) {
      entries.push([name, "link", mode, await readlink(filename)]);
    } else if (before.isFile()) {
      entries.push([name, "file", mode, await fileDigest(filename, signal)]);
      filesRead += 1;
      bytesRead += before.size;
    } else if (before.isDirectory()) {
      // A gitlink is represented by Git's index and submodule status, not its cache files.
      entries.push([name, "directory", mode]);
    } else {
      return fail("UNSUPPORTED_PROJECT_FILE", `Cannot commit special filesystem entry ${filename}. Move it outside Git-visible work or ignore it, then retry.`);
    }
    const after = await lstat(filename);
    const contentChanged = !before.isDirectory() && (before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs);
    if (before.ino !== after.ino || before.mode !== after.mode || contentChanged) {
      return fail("PROJECT_CHANGED", `Working file changed during inspection: ${filename}. Retry Initialize Repository.`);
    }
  }
  if (JSON.stringify(names) !== JSON.stringify(await repo.workingFileNames())) {
    return fail("PROJECT_CHANGED", "Git-visible files changed during inspection. Retry Initialize Repository.");
  }
  return Object.freeze({ fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), filesRead, bytesRead });
}

export interface ProjectEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "link";
  readonly mode: number;
  readonly contents?: string;
}

export interface ProjectSnapshot {
  readonly entries: readonly ProjectEntry[];
  readonly fingerprint: string;
  readonly sourceFingerprint: string;
}

export async function fileDigest(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  // Do not follow a link substituted for a file while inspecting the project.
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (signal?.aborted) return fail("CANCELLED", "Project inspection was cancelled.");
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/** Inspect files without following symbolic links, including ignored files. */
export async function snapshotProject(
  root: string,
  excludedNames: readonly string[] = [".git"],
  signal?: AbortSignal
): Promise<ProjectSnapshot> {
  const entries: ProjectEntry[] = [];
  const identities: unknown[] = [];
  const excluded = new Set(excludedNames);
  const inspect = async (name: string): Promise<void> => {
    if (signal?.aborted) return fail("CANCELLED", "Project inspection was cancelled.");
    if (excluded.has(name)) return;
    const filename = path.join(root, name);
    const before = await lstat(filename);
    identities.push([name, before.ino, before.size, before.mode, before.mtimeMs, before.ctimeMs]);
    const mode = before.mode & 0o7777;
    if (before.isSymbolicLink()) {
      entries.push({ name, kind: "link", mode, contents: await readlink(filename) });
    } else if (before.isFile()) {
      entries.push({ name, kind: "file", mode, contents: await fileDigest(filename, signal) });
    } else if (before.isDirectory()) {
      entries.push({ name, kind: "directory", mode });
      const children = (await readdir(filename)).sort();
      for (const child of children) await inspect(name ? `${name}/${child}` : child);
      if (JSON.stringify(children) !== JSON.stringify((await readdir(filename)).sort())) {
        return fail("PROJECT_CHANGED", `Project directory changed during inspection: ${filename}. Retry Initialize Repository.`);
      }
    } else {
      return fail("UNSUPPORTED_PROJECT_FILE", `Cannot safely preserve special filesystem entry ${filename}. Move it outside the project before backup or remote replacement.`);
    }
    const after = await lstat(filename);
    if (before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return fail("PROJECT_CHANGED", `Project changed during inspection: ${filename}. Retry Initialize Repository.`);
    }
  };
  await inspect("");
  const immutableEntries = Object.freeze(entries.map(entry => Object.freeze(entry)));
  return Object.freeze({
    entries: immutableEntries,
    fingerprint: createHash("sha256").update(JSON.stringify(immutableEntries)).digest("hex"),
    sourceFingerprint: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
  });
}
