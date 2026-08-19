const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { hostname } = require("os");
const { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository, GitWorktreeError, parseWorktreePorcelain } = require("../out/git");
const { commitAndSave, getFromRemote, initializeRepository } = require("../out/generalized-workflow");
const {
  CommandLockError,
  acquireRepositoryCommandLock,
  commandLockPath,
} = require("../out/repository-safety");

const projectRoot = path.resolve(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Safety Test"]);
  git(directory, ["config", "user.email", "wipstream-safety@example.invalid"]);
}

function createFixture(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", seed]);
  configureIdentity(seed);
  writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "-m", "Initial commit"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote };
}

async function withFixture(prefix, action) {
  const fixture = createFixture(prefix);
  try {
    await action(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function cloneRepository(fixture, name) {
  const directory = path.join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, directory]);
  configureIdentity(directory);
  return { directory, repo: await GitRepository.open(directory) };
}

async function expectSafetyError(action, ErrorType, code) {
  try {
    await action();
    assert.fail(`Expected safety error ${code}`);
  } catch (error) {
    assert.ok(error instanceof ErrorType, `Expected ${ErrorType.name}, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
}

function runParserCharacterization() {
  const parsed = parseWorktreePorcelain(
    "worktree /repo/main\0HEAD aaaaaa\0branch refs/heads/main\0\0"
      + "worktree /repo/topic\nwith-newline\0HEAD bbbbbb\0detached\0locked testing\0prunable stale\0\0"
  );
  assert.deepEqual(parsed, [
    {
      path: "/repo/main",
      head: "aaaaaa",
      branch: "main",
      detached: false,
      bare: false,
      locked: undefined,
      prunable: undefined,
    },
    {
      path: "/repo/topic\nwith-newline",
      head: "bbbbbb",
      branch: undefined,
      detached: true,
      bare: false,
      locked: "testing",
      prunable: "stale",
    },
  ]);
}

async function runLinkedWorktreeRefusals() {
  await withFixture("wipstream-safety-linked-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initializeRepository(first.repo);
    const linkedOne = path.join(fixture.root, "linked-one");
    const linkedTwo = path.join(fixture.root, "linked-two");
    git(first.directory, ["worktree", "add", "-b", "linked-one", linkedOne, "main"]);
    git(first.directory, ["worktree", "add", "-b", "linked-two", linkedTwo, "main"]);
    writeFileSync(path.join(linkedOne, "dirty.txt"), "must remain untouched\n");
    const dirtyBefore = git(linkedOne, ["status", "--porcelain=v1"]);

    const error = await expectSafetyError(() => getFromRemote(first.repo), GitWorktreeError, "ADDITIONAL_WORKTREES");
    assert.deepEqual(
      error.worktrees.map((worktree) => realpathSync(worktree.path)).sort(),
      [realpathSync(linkedOne), realpathSync(linkedTwo)].sort()
    );
    for (const worktree of error.worktrees) {
      assert.ok(worktree.head, `${worktree.path} reports HEAD`);
      assert.ok(worktree.branch, `${worktree.path} reports its checked-out branch`);
      assert.match(error.message, new RegExp(worktree.branch));
    }
    assert.equal(readFileSync(path.join(linkedOne, "dirty.txt"), "utf8"), "must remain untouched\n");
    assert.equal(git(linkedOne, ["status", "--porcelain=v1"]), dirtyBefore, "refusal does not inspect or modify dirty files");
  });
}

async function runFinalPreMutationRecheck() {
  await withFixture("wipstream-safety-injected-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initializeRepository(first.repo);
    writeFileSync(path.join(first.directory, "pending.txt"), "not staged or committed\n");
    const before = git(first.directory, ["rev-parse", "HEAD"]);
    const injected = path.join(fixture.root, "injected");

    await expectSafetyError(
      () => commitAndSave(first.repo, {
        requestCheckpointMessage: async () => {
          git(first.directory, ["worktree", "add", "-b", "injected", injected, "main"]);
          return "Must not commit";
        },
      }),
      GitWorktreeError,
      "ADDITIONAL_WORKTREES"
    );
    assert.equal(git(first.directory, ["rev-parse", "HEAD"]), before, "late worktree injection blocks the commit");
    assert.match(git(first.directory, ["status", "--porcelain=v1"]), /pending\.txt/);
  });
}

async function runCommandLockRefusals() {
  await withFixture("wipstream-safety-lock-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    const firstLock = await acquireRepositoryCommandLock(first.repo, "first command");
    const concurrent = await expectSafetyError(
      () => acquireRepositoryCommandLock(first.repo, "second command"),
      CommandLockError,
      "COMMAND_IN_PROGRESS"
    );
    assert.match(concurrent.message, /first command/);
    await expectSafetyError(() => getFromRemote(first.repo), CommandLockError, "COMMAND_IN_PROGRESS");
    await firstLock.release();

    const stalePath = await commandLockPath(first.repo);
    writeFileSync(stalePath, `${JSON.stringify({
      schemaVersion: 1,
      operationId: "stale-operation",
      command: "interrupted command",
      pid: 2147483647,
      hostname: hostname(),
      startedAt: "2000-01-01T00:00:00.000Z",
      repositoryRoot: first.repo.root,
    })}\n`);
    const stale = await expectSafetyError(
      () => acquireRepositoryCommandLock(first.repo, "new command"),
      CommandLockError,
      "STALE_COMMAND_LOCK"
    );
    assert.equal(stale.lockPath, stalePath);
    assert.match(stale.message, /interrupted command/);
    unlinkSync(stalePath);
  });
}

async function runSeparateCloneLocks() {
  await withFixture("wipstream-safety-clones-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    const second = await cloneRepository(fixture, "second");
    const firstLock = await acquireRepositoryCommandLock(first.repo, "first clone");
    const secondLock = await acquireRepositoryCommandLock(second.repo, "second clone");
    assert.notEqual(firstLock.path, secondLock.path, "separate clones own separate repository-local locks");
    await secondLock.release();
    await firstLock.release();
  });
}

function typescriptSources(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...typescriptSources(target));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(target);
    }
  }
  return result;
}

function runNoWorktreeMutationContract() {
  const invocations = [];
  for (const source of typescriptSources(path.join(projectRoot, "src"))) {
    const contents = readFileSync(source, "utf8");
    for (const match of contents.matchAll(/\["worktree",\s*"([^"]+)"/g)) {
      invocations.push({ source: path.relative(projectRoot, source), subcommand: match[1] });
    }
  }
  assert.ok(invocations.length > 0, "the structured worktree inspection remains present");
  assert.deepEqual([...new Set(invocations.map(({ subcommand }) => subcommand))], ["list"]);
  assert.deepEqual([...new Set(invocations.map(({ source }) => source))], ["src/git.ts"]);
}

Promise.resolve()
  .then(runParserCharacterization)
  .then(runLinkedWorktreeRefusals)
  .then(runFinalPreMutationRecheck)
  .then(runCommandLockRefusals)
  .then(runSeparateCloneLocks)
  .then(runNoWorktreeMutationContract)
  .then(() => console.log("WipStream repository safety tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
