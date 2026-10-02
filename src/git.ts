import { spawn } from "child_process";
import { existsSync } from "fs";
import { lstat, readlink, realpath, rmdir, unlink } from "fs/promises";
import * as path from "path";
import { WipStreamError } from "./errors";

export type BranchRelation = "equal" | "behind" | "ahead" | "diverged";

export interface GitRef {
  readonly name: string;
  readonly objectId: string;
  readonly upstream?: string;
}

export interface GitRefUpdate {
  readonly ref: string;
  readonly expectedOld: string | null;
  readonly proposed: string | null;
}

export interface GitRemoteRefUpdate {
  readonly ref: string;
  readonly expected: string | null;
  readonly proposed: string | null;
}

export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

export class GitWorktreeError extends WipStreamError {
  public readonly code = "ADDITIONAL_WORKTREES";
  public readonly worktrees: readonly GitWorktree[];

  constructor(worktrees: readonly GitWorktree[]) {
    const details = worktrees.map((worktree) => {
      const state = worktree.branch ? `branch ${worktree.branch}` : worktree.detached ? "detached HEAD" : "no branch";
      return `• ${worktree.path} (${state}${worktree.head ? `, ${worktree.head}` : ""})`;
    });
    super(
      "ADDITIONAL_WORKTREES",
      `WipStream requires exactly one worktree. Remove the additional Git worktrees before retrying:\n${details.join("\n")}`
    );
    this.name = "GitWorktreeError";
    this.worktrees = worktrees;
  }
}

interface MutableGitWorktree {
  path?: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: string;
  prunable?: string;
}

export function parseWorktreePorcelain(output: string): readonly GitWorktree[] {
  const result: GitWorktree[] = [];
  let current: MutableGitWorktree | undefined;

  const finish = () => {
    if (current?.path) {
      result.push({
        path: current.path,
        head: current.head,
        branch: current.branch,
        detached: current.detached ?? false,
        bare: current.bare ?? false,
        locked: current.locked,
        prunable: current.prunable,
      });
    }
    current = undefined;
  };

  for (const field of output.split("\0")) {
    if (!field) {
      finish();
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? undefined : field.slice(separator + 1);
    if (key === "worktree") {
      finish();
      current = { path: value };
    } else if (current) {
      switch (key) {
        case "HEAD": current.head = value; break;
        case "branch": current.branch = value?.replace(/^refs\/heads\//, ""); break;
        case "detached": current.detached = true; break;
        case "bare": current.bare = true; break;
        case "locked": current.locked = value || "locked"; break;
        case "prunable": current.prunable = value || "prunable"; break;
      }
    }
  }
  finish();
  return result;
}

export class GitError extends WipStreamError {
  public readonly args: readonly string[];
  public readonly exitCode: number | undefined;
  public readonly signal: NodeJS.Signals | undefined;
  public readonly cancelled: boolean;

  constructor(
    args: readonly string[],
    message: string,
    exitCode?: number,
    signal?: NodeJS.Signals,
    cancelled = false
  ) {
    super(cancelled ? "GIT_COMMAND_CANCELLED" : signal ? "GIT_COMMAND_TERMINATED" : "GIT_COMMAND_FAILED", message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.signal = signal;
    this.cancelled = cancelled;
  }
}

interface GitResult {
  readonly stdout: string;
  readonly stdoutBytes: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

interface GitExecutionOptions {
  readonly input?: string | Buffer;
  readonly signal?: AbortSignal;
}

function execute(cwd: string, args: readonly string[], options: GitExecutionOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const { input, signal } = options;
    const child = spawn("git", [...args], {
      cwd,
      shell: false,
      signal,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    let cancellationRequested = false;

    const rejectOnce = (error: GitError) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    // Keep patches as bytes; decode text only after all chunks have arrived.
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      const cancelled = signal?.aborted || error.name === "AbortError";
      if (cancelled) {
        cancellationRequested = true;
        return;
      }
      rejectOnce(new GitError(
        args,
        error.message
      ));
    });
    child.on("close", (exitCode, closeSignal) => {
      if (settled) {
        return;
      }
      const cancelled = cancellationRequested || Boolean(signal?.aborted && closeSignal);
      if (cancelled) {
        rejectOnce(new GitError(
          args,
          `git ${args.join(" ")} was cancelled.`,
          exitCode ?? undefined,
          closeSignal ?? undefined,
          true
        ));
        return;
      }
      if (exitCode === null) {
        rejectOnce(new GitError(
          args,
          `git ${args.join(" ")} was terminated${closeSignal ? ` by ${closeSignal}` : ""}.`,
          undefined,
          closeSignal ?? undefined,
          false
        ));
        return;
      }
      settled = true;
      const stdoutBytes = Buffer.concat(stdoutChunks);
      resolve({ stdout: stdoutBytes.toString("utf8"), stdoutBytes, stderr, exitCode });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export class GitRepository {
  public readonly root: string;
  private readonly networkSignal: AbortSignal | undefined;

  private constructor(root: string, networkSignal?: AbortSignal) {
    this.root = root;
    this.networkSignal = networkSignal;
  }

  public static async open(directory: string): Promise<GitRepository> {
    const result = await execute(directory, ["rev-parse", "--show-toplevel"]);
    if (result.exitCode !== 0) {
      throw new GitError(
        ["rev-parse", "--show-toplevel"],
        result.stderr.trim() || "The selected folder is not a Git working repository.",
        result.exitCode
      );
    }

    return new GitRepository(result.stdout.trim());
  }

  public async run(args: readonly string[]): Promise<string> {
    return (await this.runRaw(args)).trim();
  }

  public async createBlob(contents: string): Promise<string> {
    await this.assertSingleWorktree();
    return this.runWithInput(["hash-object", "-w", "--stdin"], contents);
  }

  public async runRaw(args: readonly string[]): Promise<string> {
    return (await this.executeChecked(args)).stdout;
  }

  private async executeChecked(args: readonly string[], options: GitExecutionOptions = {}): Promise<GitResult> {
    const result = await execute(this.root, args, options);
    if (result.exitCode !== 0) {
      const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
      throw new GitError(args, output || `git ${args.join(" ")} failed.`, result.exitCode);
    }
    return result;
  }

  public async tryRun(args: readonly string[]): Promise<GitResult> {
    return execute(this.root, args);
  }

  private async runWithInput(args: readonly string[], input: string | Buffer): Promise<string> {
    return (await this.executeChecked(args, { input })).stdout.trim();
  }

  private async runNetwork(args: readonly string[]): Promise<string> {
    return (await this.executeChecked(args, { signal: this.networkSignal })).stdout.trim();
  }

  private async mutate(args: readonly string[]): Promise<string> {
    await this.assertSingleWorktree();
    return this.run(args);
  }

  private async tryMutate(args: readonly string[]): Promise<GitResult> {
    await this.assertSingleWorktree();
    return this.tryRun(args);
  }

  private async mutateWithInput(args: readonly string[], input: string | Buffer): Promise<string> {
    await this.assertSingleWorktree();
    return this.runWithInput(args, input);
  }

  private async mutateNetwork(args: readonly string[]): Promise<string> {
    await this.assertSingleWorktree();
    return this.runNetwork(args);
  }

  public withNetworkCancellation(signal: AbortSignal): GitRepository {
    return new GitRepository(this.root, signal);
  }

  public remoteTrackingRef(remote: string, branch: string): string {
    return `refs/remotes/${remote}/${branch}`;
  }

  public localRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  public async getConfig(key: string): Promise<string | undefined> {
    const result = await this.tryRun(["config", "--local", "--get", key]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  public async getConfigValues(key: string): Promise<readonly string[]> {
    const result = await this.tryRun(["config", "--local", "--null", "--get-all", key]);
    if (result.exitCode === 1) return [];
    if (result.exitCode !== 0) throw new GitError(["config", "--get-all", key], result.stderr.trim(), result.exitCode);
    const values = result.stdout.split("\0");
    if (values[values.length - 1] === "") values.pop();
    return values;
  }

  public async setConfig(key: string, value: string): Promise<void> {
    await this.mutate(["config", "--local", key, value]);
  }

  public async replaceConfigValues(key: string, values: readonly string[]): Promise<void> {
    const unset = await this.tryMutate(["config", "--local", "--unset-all", key]);
    if (unset.exitCode !== 0 && unset.exitCode !== 5) {
      throw new GitError(["config", "--local", "--unset-all", key], unset.stderr.trim(), unset.exitCode);
    }
    for (const value of values) {
      await this.mutate(["config", "--local", "--add", key, value]);
    }
  }

  public async commonGitDirectory(): Promise<string> {
    return path.resolve(this.root, await this.run(["rev-parse", "--git-common-dir"]));
  }

  public async worktrees(): Promise<readonly GitWorktree[]> {
    const result = await this.tryRun(["worktree", "list", "--porcelain", "-z"]);
    if (result.exitCode !== 0) {
      const message = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
      throw new GitError(["worktree", "list", "--porcelain", "-z"], message, result.exitCode);
    }
    return parseWorktreePorcelain(result.stdout);
  }

  public async assertSingleWorktree(): Promise<void> {
    const worktrees = await this.worktrees();
    if (worktrees.length !== 1 || path.resolve(worktrees[0].path) !== path.resolve(this.root)) {
      const additional = worktrees.filter((worktree) => path.resolve(worktree.path) !== path.resolve(this.root));
      throw new GitWorktreeError(additional.length ? additional : worktrees);
    }
  }

  public async symbolicRef(ref: string): Promise<string | undefined> {
    const result = await this.tryRun(["symbolic-ref", "--quiet", ref]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  public async listRefs(prefix: string): Promise<readonly GitRef[]> {
    const output = await this.run([
      "for-each-ref",
      "--format=%(refname)\t%(objectname)\t%(upstream:short)",
      prefix,
    ]);
    if (!output) {
      return [];
    }

    return output.split("\n").map((line) => {
      const [name, objectId, upstream] = line.split("\t");
      return { name, objectId, upstream: upstream || undefined };
    });
  }

  public async updateRefs(updates: readonly GitRefUpdate[]): Promise<void> {
    if (!updates.length) {
      return;
    }
    const seen = new Set<string>();
    const commands: string[] = ["start"];
    for (const update of updates) {
      if (seen.has(update.ref)) {
        throw new GitError(["update-ref", "--stdin"], `Ref “${update.ref}” appears more than once in one transaction.`);
      }
      seen.add(update.ref);
      if (/[\0-\x20\x7f]/.test(update.ref) || (await this.tryRun(["check-ref-format", update.ref])).exitCode !== 0) {
        throw new GitError(["update-ref", "--stdin"], `“${update.ref}” is not a valid full Git ref name.`);
      }
      for (const objectId of [update.expectedOld, update.proposed]) {
        if (objectId !== null && !/^[0-9a-f]{40,64}$/.test(objectId)) {
          throw new GitError(["update-ref", "--stdin"], `“${objectId}” is not a valid Git object id.`);
        }
      }
      if (update.expectedOld === null && update.proposed === null) {
        throw new GitError(["update-ref", "--stdin"], `Ref “${update.ref}” has neither an expected nor proposed value.`);
      }
      if (update.expectedOld === null) {
        commands.push(`create ${update.ref} ${update.proposed}`);
      } else if (update.proposed === null) {
        commands.push(`delete ${update.ref} ${update.expectedOld}`);
      } else {
        commands.push(`update ${update.ref} ${update.proposed} ${update.expectedOld}`);
      }
    }
    commands.push("prepare", "commit");
    await this.mutateWithInput(["update-ref", "--stdin"], `${commands.join("\n")}\n`);
  }

  public async validateBranchName(branch: string): Promise<boolean> {
    const result = await this.tryRun(["check-ref-format", "--branch", branch]);
    return result.exitCode === 0;
  }

  public async currentBranch(): Promise<string | undefined> {
    const result = await this.tryRun(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  public async refExists(ref: string): Promise<boolean> {
    const result = await this.tryRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.exitCode === 0;
  }

  /** Resolve any Git object; branch helpers intentionally require commits. */
  public async objectId(ref: string): Promise<string | undefined> {
    const result = await this.tryRun(["rev-parse", "--verify", "--quiet", `${ref}^{object}`]);
    if (result.exitCode === 0) return result.stdout.trim();
    if (result.exitCode === 1) return undefined;
    throw new GitError(["rev-parse", "--verify", ref], result.stderr.trim(), result.exitCode);
  }

  public async branchExists(branch: string): Promise<boolean> {
    return this.refExists(this.localRef(branch));
  }

  public async hash(ref: string): Promise<string> {
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  public async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.tryRun(["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new GitError(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      result.stderr.trim() || "Unable to compare Git history.",
      result.exitCode
    );
  }

  public async relation(localRef: string, remoteRef: string): Promise<BranchRelation> {
    if ((await this.hash(localRef)) === (await this.hash(remoteRef))) {
      return "equal";
    }
    if (await this.isAncestor(localRef, remoteRef)) {
      return "behind";
    }
    if (await this.isAncestor(remoteRef, localRef)) {
      return "ahead";
    }
    return "diverged";
  }

  public async isBare(): Promise<boolean> {
    return (await this.run(["rev-parse", "--is-bare-repository"])) === "true";
  }

  public async isShallow(): Promise<boolean> {
    return (await this.run(["rev-parse", "--is-shallow-repository"])) === "true";
  }

  public async statusPorcelain(): Promise<string> {
    return this.runRaw(["--no-optional-locks", "status", "--porcelain=v1"]);
  }

  public async hasDirtySubmodules(): Promise<boolean> {
    const result = await this.tryRun([
      "submodule",
      "foreach",
      "--quiet",
      "--recursive",
      "test -z \"$(git status --porcelain=v1)\"",
    ]);
    return result.exitCode !== 0;
  }

  public async hasConflicts(): Promise<boolean> {
    return (await this.run(["diff", "--name-only", "--diff-filter=U"])).length > 0;
  }

  public async conflictPaths(): Promise<readonly string[]> {
    const output = await this.run(["diff", "--name-only", "--diff-filter=U", "-z"]);
    return output.split("\0").filter(Boolean).sort();
  }

  public async indexTree(): Promise<string> {
    return this.run(["write-tree"]);
  }

  public async operationInProgress(): Promise<boolean> {
    const markers = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ];

    for (const marker of markers) {
      const gitPath = await this.run(["rev-parse", "--git-path", marker]);
      if (existsSync(path.resolve(this.root, gitPath))) {
        return true;
      }
    }

    return false;
  }

  public async requireConfiguredRemote(remote: string): Promise<void> {
    await this.run(["remote", "get-url", remote]);
  }

  public async fetch(remote: string): Promise<void> {
    await this.mutateNetwork(["fetch", "--prune", remote]);
  }

  public async fetchAllBranches(remote: string): Promise<void> {
    await this.mutateNetwork([
      "fetch",
      "--prune",
      remote,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ]);
  }

  public async readRemoteDefaultBranch(remote: string): Promise<string> {
    const output = await this.runNetwork(["ls-remote", "--symref", remote, "HEAD"]);
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(output)?.[1];
    if (!branch) {
      throw new WipStreamError("REMOTE_HEAD_MISSING", `Remote “${remote}” does not identify an ordinary default branch.`);
    }
    return branch;
  }

  public async setRemoteTrackingDefaultBranch(remote: string, branch: string): Promise<void> {
    await this.mutate(["remote", "set-head", remote, branch]);
  }

  public async replaceRemoteTrackingHead(remote: string, before: string | null, after: string | null): Promise<void> {
    const ref = `refs/remotes/${remote}/HEAD`;
    if ((await this.tryRun(["check-ref-format", ref])).exitCode !== 0
      || (after !== null && (!after.startsWith(`refs/remotes/${remote}/`)
        || after === ref || (await this.tryRun(["check-ref-format", after])).exitCode !== 0))) {
      throw new WipStreamError("INVALID_REMOTE_HEAD", "The recorded remote default ref is invalid.");
    }
    const current = await this.symbolicRef(ref) ?? null;
    if (current !== before || (current === null && await this.objectId(ref))) {
      throw new WipStreamError("REMOTE_HEAD_CHANGED", "The remote default ref changed after it was inspected.");
    }
    if (before === null && after === null) return;
    if (after === null) await this.mutate(["symbolic-ref", "--delete", ref]);
    else await this.setRemoteTrackingDefaultBranch(remote, after.slice(`refs/remotes/${remote}/`.length));
  }

  public async trackedPaths(): Promise<readonly string[]> {
    return (await this.runRaw(["ls-files", "--cached", "-z"])).split("\0").filter(Boolean);
  }

  public async workingFileNames(): Promise<readonly string[]> {
    const output = await this.runRaw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    return [...new Set(output.split("\0").filter(Boolean))].sort();
  }

  public async indexEntries(): Promise<readonly { readonly entry: string; readonly flags: number }[]> {
    const output = await this.runRaw(["ls-files", "--stage", "-v", "--debug", "-z"]);
    const entries: { entry: string; flags: number }[] = [];
    let cursor = 0;
    while (cursor < output.length) {
      const separator = output.indexOf("\0", cursor);
      if (separator < 0) throw new WipStreamError("INDEX_INSPECTION_FAILED", "Git returned an incomplete index entry.");
      const entry = output.slice(cursor, separator);
      cursor = separator + 1;
      const debugStart = cursor;
      // Git emits five stat-cache lines after each NUL-terminated entry.
      for (let line = 0; line < 5; line += 1) {
        const end = output.indexOf("\n", cursor);
        if (end < 0) throw new WipStreamError("INDEX_INSPECTION_FAILED", "Git returned incomplete index flags.");
        cursor = end + 1;
      }
      const flags = /\tflags: ([0-9a-f]+)\n$/i.exec(output.slice(debugStart, cursor))?.[1];
      if (flags === undefined) throw new WipStreamError("INDEX_INSPECTION_FAILED", "Git returned unrecognized index flags.");
      // Keep assume-unchanged, intent-to-add, and skip-worktree; discard cache-validity bits.
      const semanticFlags = Number.parseInt(flags, 16) & 0x60008000;
      entries.push({ entry, flags: semanticFlags });
    }
    return entries;
  }

  public async treePaths(commit: string): Promise<readonly { readonly name: string; readonly mode: string; readonly objectId: string }[]> {
    const output = await this.runRaw(["ls-tree", "-r", "-z", "--full-tree", commit]);
    return output.split("\0").filter(Boolean).map(entry => {
      const separator = entry.indexOf("\t");
      const [mode, , objectId] = entry.slice(0, separator).split(" ");
      return { name: entry.slice(separator + 1), mode, objectId };
    });
  }

  public async ignoredPaths(names: readonly string[]): Promise<readonly string[]> {
    if (!names.length) return [];
    const args = ["check-ignore", "--no-index", "--stdin", "-z"];
    const result = await execute(this.root, args, { input: `${names.join("\0")}\0` });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new GitError(args, result.stderr.trim(), result.exitCode);
    return result.stdout.split("\0").filter(Boolean);
  }

  public async branchConfigurationKeys(branch: string): Promise<readonly string[]> {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const args = ["config", "--local", "--name-only", "--null", "--get-regexp", `^branch\\.${escaped}\\.[^.]+$`];
    const result = await this.tryRun(args);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new GitError(args, result.stderr.trim(), result.exitCode);
    return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
  }

  /** Remove exactly the approved untracked entries, never recursively. */
  public async removeWorkingFiles(names: readonly string[], directories: readonly string[]): Promise<void> {
    await this.assertSingleWorktree();
    const projectRoot = await realpath(this.root);
    const filename = (name: string): string => {
      const resolved = path.resolve(this.root, name);
      const relative = path.relative(this.root, resolved);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new WipStreamError("INVALID_REPLACEMENT_PATH", `Invalid approved replacement path: ${name}.`);
      }
      return resolved;
    };
    const requireProjectParent = async (target: string, name: string): Promise<void> => {
      const parent = await realpath(path.dirname(target));
      const relativeParent = path.relative(projectRoot, parent);
      if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
        throw new WipStreamError("REPLACEMENT_PATH_CHANGED", `An approved entry's parent now points outside the project: ${name}.`);
      }
    };
    for (const name of names) {
      const target = filename(name);
      await requireProjectParent(target, name);
      if ((await lstat(target)).isDirectory()) throw new WipStreamError("REPLACEMENT_PATH_CHANGED", `Approved file became a directory: ${name}.`);
      await unlink(target);
    }
    for (const name of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
      try {
        const target = filename(name);
        await requireProjectParent(target, name);
        await rmdir(target);
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }

  public async replaceWorkingFiles(commit: string): Promise<void> {
    await this.mutate(["switch", "--detach", "--discard-changes", commit]);
  }

  public async detach(): Promise<void> {
    await this.mutate(["switch", "--detach"]);
  }

  public async switch(branch: string): Promise<void> {
    await this.mutate(["switch", branch]);
  }

  public async switchNewBranch(branch: string, startPoint: string): Promise<void> {
    await this.mutate(["switch", "-c", branch, startPoint]);
  }

  public async merge(branch: string): Promise<void> {
    await this.mutate(["merge", "--no-edit", branch]);
  }

  public async commitMerge(): Promise<void> {
    await this.mutate(["commit", "--no-edit"]);
  }

  public async abortMerge(): Promise<void> {
    await this.mutate(["merge", "--abort"]);
  }

  public async countCommits(range: string): Promise<number> {
    const count = Number(await this.run(["rev-list", "--count", range]));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new GitError(["rev-list", "--count", range], "Git returned an invalid commit count.");
    }
    return count;
  }

  public async createCommitFromTree(treeish: string, parent: string, message: string): Promise<string> {
    const tree = await this.run(["rev-parse", `${treeish}^{tree}`]);
    return this.mutate(["commit-tree", tree, "-p", parent, "-m", message]);
  }

  public async restoreCommitChanges(before: string, after: string): Promise<void> {
    const patch = (await this.executeChecked(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", before, after, "--"])).stdoutBytes;
    if (patch.length) {
      await this.mutateWithInput(["apply", "--whitespace=nowarn"], patch);
    }
  }

  public async verifyRestoredCommitChanges(before: string, after: string): Promise<void> {
    const changed = (await this.runRaw(["diff", "--name-only", "--no-renames", "-z", before, after, "--"]))
      .split("\0").filter(Boolean);
    const expected = new Map((await this.treePaths(after)).map(entry => [entry.name, entry]));
    for (const name of changed) {
      const entry = expected.get(name);
      const filename = path.join(this.root, name);
      let actual;
      try {
        actual = await lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!entry && !actual) continue;
      if (!entry || !actual) throw new WipStreamError("CHECKPOINT_RESTORATION_FAILED", `Checkpoint path ${name} was not restored.`);
      const objectId = actual.isSymbolicLink()
        ? await this.runWithInput(["hash-object", "--stdin"], await readlink(filename, { encoding: "buffer" }))
        : actual.isFile() ? await this.run(["hash-object", `--path=${name}`, "--", name]) : undefined;
      const fileMode = await this.getConfig("core.filemode") !== "false";
      const modeMatches = entry.mode === "120000" ? actual.isSymbolicLink()
        : actual.isFile() && (!fileMode || Boolean(actual.mode & 0o111) === (entry.mode === "100755"));
      if (objectId !== entry.objectId || !modeMatches) {
        throw new WipStreamError("CHECKPOINT_RESTORATION_FAILED", `Checkpoint contents or mode differ at ${name}.`);
      }
    }
  }

  public async stageAll(): Promise<void> {
    await this.mutate(["add", "--all"]);
  }

  public async hasStagedChanges(): Promise<boolean> {
    const result = await this.tryRun(["diff", "--cached", "--quiet"]);
    if (result.exitCode === 0) {
      return false;
    }
    if (result.exitCode === 1) {
      return true;
    }
    throw new GitError(
      ["diff", "--cached", "--quiet"],
      result.stderr.trim() || "Unable to inspect staged changes.",
      result.exitCode
    );
  }

  public async commit(message: string): Promise<void> {
    await this.mutate(["commit", "-m", message]);
  }

  public async pushRefsAtomic(
    remote: string,
    updates: readonly GitRemoteRefUpdate[],
    dryRun = false
  ): Promise<void> {
    if (!updates.length) {
      return;
    }
    const seen = new Set<string>();
    for (const update of updates) {
      if (seen.has(update.ref)) {
        throw new GitError(["push", "--atomic"], `Remote ref “${update.ref}” appears more than once.`);
      }
      seen.add(update.ref);
      if (/[\0-\x20\x7f]/.test(update.ref) || (await this.tryRun(["check-ref-format", update.ref])).exitCode !== 0) {
        throw new GitError(["push", "--atomic"], `“${update.ref}” is not a valid full Git ref name.`);
      }
      for (const objectId of [update.expected, update.proposed]) {
        if (objectId !== null && !/^[0-9a-f]{40,64}$/.test(objectId)) {
          throw new GitError(["push", "--atomic"], `“${objectId}” is not a valid Git object id.`);
        }
      }
    }
    const leases = updates.map(
      (update) => `--force-with-lease=${update.ref}:${update.expected ?? ""}`
    );
    const refspecs = updates.map(
      (update) => `${update.proposed ?? ""}:${update.ref}`
    );
    await this.mutateNetwork(["push", "--atomic", ...(dryRun ? ["--dry-run"] : []), ...leases, remote, ...refspecs]);
  }

  public async verifyAtomicPushSupport(remote: string, ref: string, objectId: string): Promise<void> {
    await this.pushRefsAtomic(remote, [{ ref, expected: objectId, proposed: objectId }], true);
  }
}
