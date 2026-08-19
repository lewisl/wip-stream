import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

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

export class GitWorktreeError extends Error {
  public readonly code = "ADDITIONAL_WORKTREES";
  public readonly worktrees: readonly GitWorktree[];

  constructor(worktrees: readonly GitWorktree[]) {
    const details = worktrees.map((worktree) => {
      const state = worktree.branch ? `branch ${worktree.branch}` : worktree.detached ? "detached HEAD" : "no branch";
      return `• ${worktree.path} (${state}${worktree.head ? `, ${worktree.head}` : ""})`;
    });
    super(`WipStream requires exactly one worktree. Remove the additional Git worktrees before retrying:\n${details.join("\n")}`);
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

export class GitError extends Error {
  public readonly args: readonly string[];
  public readonly exitCode: number | undefined;

  constructor(args: readonly string[], message: string, exitCode?: number) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
  }
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function execute(cwd: string, args: readonly string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, shell: false });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(new GitError(args, error.message)));
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode === null ? 1 : exitCode });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

export class GitRepository {
  public readonly root: string;

  private constructor(root: string) {
    this.root = root;
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
    const result = await execute(this.root, args);
    if (result.exitCode !== 0) {
      const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
      throw new GitError(args, output || `git ${args.join(" ")} failed.`, result.exitCode);
    }
    return result.stdout.trim();
  }

  public async tryRun(args: readonly string[]): Promise<GitResult> {
    return execute(this.root, args);
  }

  private async runWithInput(args: readonly string[], input: string): Promise<string> {
    const result = await execute(this.root, args, input);
    if (result.exitCode !== 0) {
      const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
      throw new GitError(args, output || `git ${args.join(" ")} failed.`, result.exitCode);
    }
    return result.stdout.trim();
  }

  public remoteRef(remote: string, branch: string): string {
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
    const result = await this.tryRun(["config", "--local", "--get-all", key]);
    return result.exitCode === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  }

  public async setConfig(key: string, value: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["config", "--local", key, value]);
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
    await this.assertSingleWorktree();
    await this.runWithInput(["update-ref", "--stdin"], `${commands.join("\n")}\n`);
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
    return this.run(["status", "--porcelain=v1"]);
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

  public async ensureRemote(remote: string): Promise<void> {
    await this.run(["remote", "get-url", remote]);
  }

  public async fetch(remote: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["fetch", "--prune", remote]);
  }

  public async fetchAllBranches(remote: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run([
      "fetch",
      "--prune",
      remote,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ]);
  }

  public async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["branch", branch, startPoint]);
  }

  public async createTrackingBranch(branch: string, remoteRef: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["branch", "--track", branch, remoteRef]);
  }

  public async setUpstream(branch: string, remoteRef: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["branch", "--set-upstream-to", remoteRef, branch]);
  }

  public async configureTracking(branch: string, remote: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["config", "--local", `branch.${branch}.remote`, remote]);
    await this.assertSingleWorktree();
    await this.run(["config", "--local", `branch.${branch}.merge`, `refs/heads/${branch}`]);
  }

  public async configureFullBranchFetch(remote: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run([
      "config",
      "--local",
      "--replace-all",
      `remote.${remote}.fetch`,
      `+refs/heads/*:refs/remotes/${remote}/*`,
    ]);
  }

  public async moveBranch(branch: string, target: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["branch", "-f", branch, target]);
  }

  public async detach(): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["switch", "--detach"]);
  }

  public async switch(branch: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["switch", branch]);
  }

  public async switchNewBranch(branch: string, startPoint: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["switch", "-c", branch, startPoint]);
  }

  public async merge(branch: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["merge", "--no-edit", branch]);
  }

  public async countCommits(range: string): Promise<number> {
    const count = Number(await this.run(["rev-list", "--count", range]));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new GitError(["rev-list", "--count", range], "Git returned an invalid commit count.");
    }
    return count;
  }

  public async createCommitFromTree(treeish: string, parent: string, message: string): Promise<string> {
    await this.assertSingleWorktree();
    const tree = await this.run(["rev-parse", `${treeish}^{tree}`]);
    return this.run(["commit-tree", tree, "-p", parent, "-m", message]);
  }

  public async removeBranchConfiguration(branch: string): Promise<void> {
    await this.assertSingleWorktree();
    const result = await this.tryRun(["config", "--local", "--remove-section", `branch.${branch}`]);
    if (result.exitCode !== 0 && result.exitCode !== 5) {
      throw new GitError(
        ["config", "--local", "--remove-section", `branch.${branch}`],
        result.stderr.trim() || `Unable to remove configuration for branch “${branch}”.`,
        result.exitCode
      );
    }
  }

  public async fastForward(target: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["merge", "--ff-only", target]);
  }

  public async stageAll(): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["add", "--all"]);
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
    await this.assertSingleWorktree();
    await this.run(["commit", "-m", message]);
  }

  public async pushAtomic(
    remote: string,
    refspecs: readonly string[],
    leases: Readonly<Record<string, string>> = {}
  ): Promise<void> {
    await this.assertSingleWorktree();
    const leaseArgs = Object.entries(leases).map(
      ([branch, expected]) => `--force-with-lease=refs/heads/${branch}:${expected}`
    );
    await this.run(["push", "--atomic", ...leaseArgs, remote, ...refspecs]);
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
    await this.assertSingleWorktree();
    await this.run(["push", "--atomic", ...(dryRun ? ["--dry-run"] : []), ...leases, remote, ...refspecs]);
  }

  public async verifyAtomicPushSupport(remote: string, ref: string, objectId: string): Promise<void> {
    await this.pushRefsAtomic(remote, [{ ref, expected: objectId, proposed: objectId }], true);
  }

  public async verifyAtomicPush(remote: string, branch: string): Promise<void> {
    await this.assertSingleWorktree();
    await this.run(["push", "--atomic", "--dry-run", remote, `${branch}:${branch}`]);
  }

  public async deleteLocalBranch(branch: string): Promise<void> {
    if (await this.branchExists(branch)) {
      await this.assertSingleWorktree();
      await this.run(["branch", "-d", branch]);
    }
  }
}
