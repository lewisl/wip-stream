const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { GeneralizedWorkflowError, commitAndSave, initializeRepository } = require("../out/generalized-workflow");
const { startBranch, updateFromParent } = require("../out/lifecycle-workflow");
const {
  ConflictWorkflowError,
  abortPendingMerge,
  continuePendingMerge,
  inspectPendingMerge,
  reconcileWithRemote,
} = require("../out/conflict-workflow");
const { readOperationReceipt } = require("../out/operations");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Conflict Test"]);
  git(directory, ["config", "user.email", "wipstream-conflict@example.invalid"]);
}

function fixture(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", seed]);
  configureIdentity(seed);
  writeFileSync(path.join(seed, "shared.txt"), "baseline\n");
  git(seed, ["add", "shared.txt"]);
  git(seed, ["commit", "-m", "Baseline"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote };
}

async function withFixture(prefix, action) {
  const value = fixture(prefix);
  try {
    await action(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

async function clone(value, name, initialize = false) {
  const directory = path.join(value.root, name);
  git(value.root, ["clone", value.remote, directory]);
  configureIdentity(directory);
  const repo = await GitRepository.open(directory);
  if (initialize) await initializeRepository(repo);
  return { directory, repo };
}

function commitFile(directory, name, text, message) {
  writeFileSync(path.join(directory, name), text);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

async function expectConflictError(action, code) {
  try {
    await action();
    assert.fail(`Expected conflict error ${code}`);
  } catch (error) {
    assert.ok(error instanceof ConflictWorkflowError, `Expected ConflictWorkflowError, got ${error}`);
    assert.equal(error.code, code);
  }
}

async function createDivergence(value, conflict) {
  const first = await clone(value, "first", true);
  const second = await clone(value, "second");
  if (conflict) {
    commitFile(first.directory, "shared.txt", "local\n", "Local side");
    commitFile(second.directory, "shared.txt", "remote\n", "Remote side");
  } else {
    commitFile(first.directory, "local.txt", "local\n", "Local side");
    commitFile(second.directory, "remote.txt", "remote\n", "Remote side");
  }
  git(second.directory, ["push", "origin", "main"]);
  const refused = await commitAndSave(first.repo);
  assert.equal(refused.failure, "unsafe-branches");
  assert.equal(refused.reconcileBranch, "main");
  return { first, second };
}

async function runCleanReconcile() {
  await withFixture("wipstream-reconcile-clean-", async (value) => {
    const { first, second } = await createDivergence(value, false);
    const localTip = git(first.directory, ["rev-parse", "main"]);
    const remoteTip = git(second.directory, ["rev-parse", "main"]);
    const result = await reconcileWithRemote(first.repo);
    assert.equal(result.pending, false);
    assert.equal(result.save.published, true);
    const parents = git(first.directory, ["rev-list", "--parents", "-n", "1", "main"]).split(" ").slice(1);
    assert.deepEqual(new Set(parents), new Set([localTip, remoteTip]));
    assert.equal(git(first.directory, ["rev-parse", "main"]), git(value.remote, ["rev-parse", "main"]));
    assert.equal(await inspectPendingMerge(first.repo), undefined);
  });
}

async function runConflictedReconcileAbortAndRestart() {
  await withFixture("wipstream-reconcile-conflict-", async (value) => {
    const { first } = await createDivergence(value, true);
    const preHead = git(first.directory, ["rev-parse", "main"]);
    const preIndex = await first.repo.indexTree();
    const preStatus = await first.repo.statusPorcelain();
    const result = await reconcileWithRemote(first.repo);
    assert.equal(result.pending, true);
    assert.deepEqual(result.conflicts, ["shared.txt"]);

    const reopened = await GitRepository.open(first.directory);
    assert.deepEqual(await inspectPendingMerge(reopened), {
      operationId: result.operationId,
      command: "Reconcile with Remote",
      branch: "main",
      mergeTarget: "refs/remotes/origin/main",
      conflicts: ["shared.txt"],
      actions: ["continue", "abort"],
    });
    await expectConflictError(() => continuePendingMerge(reopened), "UNRESOLVED_CONFLICTS");
    await assert.rejects(
      () => commitAndSave(reopened),
      (error) => error instanceof GeneralizedWorkflowError && error.code === "GIT_OPERATION_IN_PROGRESS"
    );

    const aborted = await abortPendingMerge(reopened);
    assert.equal(aborted.restored, true);
    assert.equal(git(first.directory, ["rev-parse", "main"]), preHead);
    assert.equal(await reopened.indexTree(), preIndex);
    assert.equal(await reopened.statusPorcelain(), preStatus);
    assert.equal(await reopened.operationInProgress(), false);
    assert.equal(await inspectPendingMerge(reopened), undefined);
    assert.equal((await readOperationReceipt(reopened, result.operationId)).status, "aborted");
  });
}

async function runConflictedUpdateContinue() {
  await withFixture("wipstream-update-conflict-", async (value) => {
    const first = await clone(value, "first", true);
    await startBranch(first.repo, "feature");
    commitFile(first.directory, "shared.txt", "feature version\n", "Feature side");
    await commitAndSave(first.repo);
    git(first.directory, ["switch", "main"]);
    commitFile(first.directory, "shared.txt", "parent version\n", "Parent side");
    await commitAndSave(first.repo);
    git(first.directory, ["switch", "feature"]);

    const update = await updateFromParent(first.repo);
    assert.equal(update.pending, true);
    assert.deepEqual(update.conflicts, ["shared.txt"]);
    const pending = await inspectPendingMerge(first.repo);
    assert.equal(pending.command, "Update from Parent");
    assert.deepEqual(pending.actions, ["continue", "abort"]);
    await expectConflictError(() => continuePendingMerge(first.repo), "UNRESOLVED_CONFLICTS");

    writeFileSync(path.join(first.directory, "shared.txt"), "resolved feature and parent\n");
    git(first.directory, ["add", "shared.txt"]);
    const continued = await continuePendingMerge(first.repo);
    assert.equal(continued.command, "Update from Parent");
    assert.equal(continued.save.published, true);
    assert.equal(await inspectPendingMerge(first.repo), undefined);
    assert.equal(git(first.directory, ["rev-parse", "feature"]), git(value.remote, ["rev-parse", "feature"]));
  });
}

async function runAbortVerificationFailure() {
  await withFixture("wipstream-abort-verification-", async (value) => {
    const { first } = await createDivergence(value, true);
    const pending = await reconcileWithRemote(first.repo);
    await expectConflictError(
      () => abortPendingMerge(first.repo, {
        afterGitAbort: async () => writeFileSync(path.join(first.directory, "unexpected.txt"), "later work\n"),
      }),
      "ABORT_VERIFICATION_FAILED"
    );
    const receipt = await readOperationReceipt(first.repo, pending.operationId);
    assert.equal(receipt.status, "in-progress");
    assert.equal(receipt.pendingMerge.command, "Reconcile with Remote");
    assert.equal(await first.repo.operationInProgress(), false);
    assert.match(await first.repo.statusPorcelain(), /unexpected\.txt/);
  });
}

Promise.resolve()
  .then(runCleanReconcile)
  .then(runConflictedReconcileAbortAndRestart)
  .then(runConflictedUpdateContinue)
  .then(runAbortVerificationFailure)
  .then(() => console.log("WipStream guided conflict workflow tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
