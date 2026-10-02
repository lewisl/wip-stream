const assert = require("assert/strict");
const { writeFileSync } = require("fs");
const path = require("path");
const { git, commitFile, withFixture: sharedFixture } = require("./setup-fixture");
const { repositoryState } = require("./fixture-state");

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

async function withFixture(prefix, action) {
  return sharedFixture(action, { prefix, initialFile: "shared.txt" });
}

async function clone(value, name, initialize = false) {
  const { directory, repo } = await value.clone(name);
  if (initialize) await initializeRepository(repo);
  return { directory, repo };
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

async function runConflictedReconcileContinue() {
  await withFixture("wipstream-reconcile-continue-", async value => {
    const { first, second } = await createDivergence(value, true);
    const localTip = await first.repo.hash("main");
    const remoteTip = await second.repo.hash("main");
    const pending = await reconcileWithRemote(first.repo);
    assert.equal(pending.pending, true);
    assert.deepEqual(await first.repo.conflictPaths(), ["shared.txt"]);
    await expectConflictError(() => continuePendingMerge(first.repo), "UNRESOLVED_CONFLICTS");
    writeFileSync(path.join(first.directory, "shared.txt"), "resolved both sides\n");
    git(first.directory, ["add", "shared.txt"]);
    assert.deepEqual(await first.repo.conflictPaths(), []);
    assert.equal(await first.repo.operationInProgress(), true, "Continue handles an active merge, rather than an external commit");
    const result = await continuePendingMerge(first.repo);
    assert.equal(result.operationId, pending.operationId);
    assert.equal(result.command, "Reconcile with Remote");
    assert.equal(result.save.published, true);
    assert.equal(await first.repo.operationInProgress(), false);
    assert.equal(await inspectPendingMerge(first.repo), undefined);
    const parents = git(first.directory, ["rev-list", "--parents", "-n", "1", "main"]).split(" ").slice(1);
    assert.deepEqual(new Set(parents), new Set([localTip, remoteTip]));
    assert.equal(git(value.remote, ["show", "main:shared.txt"]), "resolved both sides");
    assert.equal((await readOperationReceipt(first.repo, pending.operationId)).status, "completed");
  });
}

async function runContinueCheckoutChanged() {
  await withFixture("wipstream-continue-checkout-", async value => {
    const { first } = await createDivergence(value, true);
    const pending = await reconcileWithRemote(first.repo);
    writeFileSync(path.join(first.directory, "shared.txt"), "resolved\n");
    git(first.directory, ["add", "shared.txt"]);
    assert.deepEqual(await first.repo.conflictPaths(), []);
    assert.equal(await first.repo.operationInProgress(), true);
    const before = await repositoryState(first.repo, value.remote);
    const currentBranch = first.repo.currentBranch.bind(first.repo);
    // Git blocks ordinary switching during a merge. Simulate a changed
    // checkout reported by the repository adapter at Continue's guard.
    first.repo.currentBranch = async () => "another-branch";
    try {
      await expectConflictError(() => continuePendingMerge(first.repo), "CHECKOUT_CHANGED");
    } finally {
      first.repo.currentBranch = currentBranch;
    }
    assert.deepEqual(await repositoryState(first.repo, value.remote), before);
    assert.equal((await readOperationReceipt(first.repo, pending.operationId)).status, "in-progress");
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
  .then(runConflictedReconcileContinue)
  .then(runContinueCheckoutChanged)
  .then(runAbortVerificationFailure)
  .then(() => console.log("WipStream guided conflict workflow tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
