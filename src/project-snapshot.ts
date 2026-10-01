import { createHash } from "crypto";
import { constants } from "fs";
import { lstat, open, readdir, readlink } from "fs/promises";
import * as path from "path";
import { fail } from "./errors";

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
      return fail("UNSUPPORTED_PROJECT_FILE", `Cannot safely inspect special filesystem entry ${filename}.`);
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
