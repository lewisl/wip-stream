import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

export type BranchRelation = "equal" | "behind" | "ahead" | "diverged";

export interface GitRef {
  readonly name: string;
  readonly objectId: string;
  readonly upstream?: string;
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

function execute(cwd: string, args: readonly string[]): Promise<GitResult> {
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

  public async setConfig(key: string, value: string): Promise<void> {
    await this.run(["config", "--local", key, value]);
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
    await this.run(["fetch", "--prune", remote]);
  }

  public async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.run(["branch", branch, startPoint]);
  }

  public async createTrackingBranch(branch: string, remoteRef: string): Promise<void> {
    await this.run(["branch", "--track", branch, remoteRef]);
  }

  public async setUpstream(branch: string, remoteRef: string): Promise<void> {
    await this.run(["branch", "--set-upstream-to", remoteRef, branch]);
  }

  public async moveBranch(branch: string, target: string): Promise<void> {
    await this.run(["branch", "-f", branch, target]);
  }

  public async detach(): Promise<void> {
    await this.run(["switch", "--detach"]);
  }

  public async switch(branch: string): Promise<void> {
    await this.run(["switch", branch]);
  }

  public async fastForward(target: string): Promise<void> {
    await this.run(["merge", "--ff-only", target]);
  }

  public async stageAll(): Promise<void> {
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
    await this.run(["commit", "-m", message]);
  }

  public async pushAtomic(
    remote: string,
    refspecs: readonly string[],
    leases: Readonly<Record<string, string>> = {}
  ): Promise<void> {
    const leaseArgs = Object.entries(leases).map(
      ([branch, expected]) => `--force-with-lease=refs/heads/${branch}:${expected}`
    );
    await this.run(["push", "--atomic", ...leaseArgs, remote, ...refspecs]);
  }

  public async verifyAtomicPush(remote: string, branch: string): Promise<void> {
    await this.run(["push", "--atomic", "--dry-run", remote, `${branch}:${branch}`]);
  }

  public async deleteLocalBranch(branch: string): Promise<void> {
    if (await this.branchExists(branch)) {
      await this.run(["branch", "-d", branch]);
    }
  }
}
