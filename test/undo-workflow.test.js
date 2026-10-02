const assert = require("assert/strict");
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require("fs");
const path = require("path");
const { withFixture, git, commitFile } = require("./setup-fixture");
const { repositoryState } = require("./fixture-state");
const { commitAndSave, getFromRemote, initializeRepository } = require("../out/generalized-workflow");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { condenseBranch, finishBranch, startBranch, updateFromParent } = require("../out/lifecycle-workflow");
const { reconcileWithRemote, abortPendingMerge } = require("../out/conflict-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectIncompleteOperations, readOperationReceipt } = require("../out/operations");
const { UndoWorkflowError, inspectUndoEligibility, undoLastAction } = require("../out/undo-workflow");

async function initializedClone(fixture, name = "worker") {
  const value = await fixture.clone(name);
  const result = await executeRepositorySetup(value.repo, await inspectRepositorySetup(value.repo), { kind: "local-work" });
  assert.equal(result.kind, "completed", result.message);
  return value;
}

function tip(directory, branch) {
  return git(directory, ["rev-parse", `refs/heads/${branch}`]);
}

function branchExists(directory, branch) {
  return git(directory, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]) === `refs/heads/${branch}`;
}

async function expectUndoRefusal(action) {
  await assert.rejects(action, error => error instanceof UndoWorkflowError && error.code === "UNDO_NOT_ELIGIBLE");
}

async function undoLegacyInit() {
  await withFixture(async fixture => {
    git(fixture.seed, ["switch", "-c", "topic"]);
    commitFile(fixture.seed, "topic.txt", "topic\n", "Topic");
    git(fixture.seed, ["push", "-u", "origin", "topic"]);
    const { directory, repo } = await fixture.clone("worker");
    const result = await initializeRepository(repo);
    assert.equal(branchExists(directory, "topic"), true);
    assert.equal((await inspectUndoEligibility(repo)).operationId, result.operationId);
    await undoLastAction(repo);
    assert.equal(branchExists(directory, "topic"), false);
    assert.deepEqual(await readRepositoryConfiguration(repo), { kind: "uninitialized" });
  });
}

async function undoGet() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const before = tip(directory, "main");
    const publisher = await fixture.clone("publisher");
    commitFile(publisher.directory, "advance.txt", "advance\n", "Advance");
    git(publisher.directory, ["push", "origin", "main"]);
    const result = await getFromRemote(repo);
    assert.notEqual(tip(directory, "main"), before);
    assert.equal((await inspectUndoEligibility(repo)).operationId, result.operationId);
    await undoLastAction(repo);
    assert.equal(tip(directory, "main"), before);
    assert.equal(await repo.currentBranch(), "main");
  });
}

async function undoGetCreatedBranch() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const publisher = await fixture.clone("publisher");
    git(publisher.directory, ["switch", "-c", "topic"]);
    commitFile(publisher.directory, "topic.txt", "topic\n");
    git(publisher.directory, ["push", "origin", "topic"]);
    assert.equal(branchExists(directory, "topic"), false);
    assert.deepEqual(await repo.branchConfigurationKeys("topic"), []);
    const remoteBefore = git(fixture.remote, ["rev-parse", "topic"]);
    const result = await getFromRemote(repo);
    assert.equal(branchExists(directory, "topic"), true);
    assert.deepEqual(await repo.getConfigValues("branch.topic.remote"), ["origin"]);
    assert.deepEqual(await repo.getConfigValues("branch.topic.merge"), ["refs/heads/topic"]);
    await undoLastAction(repo);
    assert.equal(branchExists(directory, "topic"), false);
    assert.deepEqual(await repo.branchConfigurationKeys("topic"), []);
    assert.equal(git(fixture.remote, ["rev-parse", "topic"]), remoteBefore);
    assert.equal((await readOperationReceipt(repo, result.operationId)).status, "undone");
  });
}

async function undoSave() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const before = tip(directory, "main");
    writeFileSync(path.join(directory, "saved.txt"), "saved content\n");
    const saved = await commitAndSave(repo, { requestCheckpointMessage: async () => "Checkpoint" });
    assert.equal(saved.published, true);
    const undone = await undoLastAction(repo);
    assert.equal(undone.restoredCheckpoint, true);
    assert.equal(tip(directory, "main"), before);
    assert.equal(readFileSync(path.join(directory, "saved.txt"), "utf8"), "saved content\n");
    assert.match(await repo.statusPorcelain(), /saved\.txt/);
    await expectUndoRefusal(() => undoLastAction(repo));
  });
}

async function undoDeletedAndBinaryFiles() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const originalBytes = Buffer.from([0, 255, 1, 10, 128]);
    writeFileSync(path.join(directory, "binary.dat"), originalBytes);
    commitFile(directory, "deleted.txt", "delete this tracked file\n", "Tracked files");
    assert.equal((await commitAndSave(repo)).published, true);
    const before = await repo.hash("HEAD");
    const changedBytes = Buffer.from([0, 128, 255, 42, 10, 0]);
    assert.notDeepEqual(changedBytes, originalBytes);
    assert.equal(existsSync(path.join(directory, "deleted.txt")), true);
    unlinkSync(path.join(directory, "deleted.txt"));
    writeFileSync(path.join(directory, "binary.dat"), changedBytes);
    assert.match(await repo.statusPorcelain(), / D deleted\.txt/);
    const saved = await commitAndSave(repo);
    assert.equal(saved.checkpointCreated, true);
    assert.equal(saved.published, true);
    assert.notEqual(await repo.hash("HEAD"), before);
    await undoLastAction(repo);
    assert.equal(await repo.hash("HEAD"), before);
    assert.equal(git(fixture.remote, ["rev-parse", "main"]), before);
    assert.equal(existsSync(path.join(directory, "deleted.txt")), false);
    assert.deepEqual(readFileSync(path.join(directory, "binary.dat")), changedBytes);
    assert.match(await repo.statusPorcelain(), / D deleted\.txt/);
    assert.match(await repo.statusPorcelain(), / M binary\.dat/);
    assert.equal(git(directory, ["diff", "--cached", "--name-only"]), "");
  });
}

async function laterWorkRefusals() {
  for (const condition of ["local-commit", "working-file", "remote-commit"]) {
    await withFixture(async fixture => {
      const { directory, repo } = await initializedClone(fixture);
      writeFileSync(path.join(directory, "x.txt"), "x\n");
      await commitAndSave(repo);
      assert.equal((await inspectUndoEligibility(repo)).eligible, true);
      if (condition === "local-commit") {
        commitFile(directory, "later.txt", "later\n", "Later");
      } else if (condition === "working-file") {
        writeFileSync(path.join(directory, "later.txt"), "later\n");
      } else {
        const publisher = await fixture.clone("publisher");
        commitFile(publisher.directory, "later.txt", "later\n", "Later");
        git(publisher.directory, ["push", "origin", "main"]);
      }
      const before = await repositoryState(repo, fixture.remote);
      if (condition === "remote-commit") {
        await assert.rejects(() => undoLastAction(repo), error => error instanceof UndoWorkflowError && error.code === "REMOTE_CHANGED_AFTER_OPERATION");
      } else {
        assert.equal((await inspectUndoEligibility(repo)).eligible, false);
        await expectUndoRefusal(() => undoLastAction(repo));
      }
      assert.deepEqual(await repositoryState(repo, fixture.remote), before);
    });
  }
}

async function interruptedUndo() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    writeFileSync(path.join(directory, "x.txt"), "x\n");
    await commitAndSave(repo);
    await assert.rejects(() => undoLastAction(repo, {
      afterRemotePush: async () => { throw new Error("interrupt undo"); },
    }), /interrupt undo/);
    const incomplete = await inspectIncompleteOperations(repo);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].phase, "after-remote-push");
    assert.equal(incomplete[0].plan.command, "Undo Commit and Save");
  });
}

async function undoFinish(disposition) {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const mainBefore = tip(directory, "main");
    await startBranch(repo, "feature");
    writeFileSync(path.join(directory, "feature.txt"), "feature\n");
    const finished = await finishBranch(repo, {
      save: { requestCheckpointMessage: async () => "Feature" },
      chooseDisposition: async () => disposition,
    });
    await undoLastAction(repo);
    assert.equal(tip(directory, "main"), mainBefore);
    assert.equal(await repo.currentBranch(), "feature");
    assert.equal(branchExists(directory, "feature"), true);
    assert.equal(branchExists(fixture.remote, "feature"), true);
    if (disposition === "delete") assert.equal(git(directory, ["config", "--get", "branch.feature.wipstreamParent"]), "main");
    assert.equal(finished.branch, "feature");
  });
}

async function undoCondense() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    await startBranch(repo, "feature");
    commitFile(directory, "one.txt", "1\n", "One");
    commitFile(directory, "two.txt", "2\n", "Two");
    await commitAndSave(repo);
    const oldTip = tip(directory, "feature");
    await condenseBranch(repo, { confirmPreview: async () => true, requestMessage: async () => "Condensed" });
    await undoLastAction(repo);
    assert.equal(tip(directory, "feature"), oldTip);
    assert.equal(tip(fixture.remote, "feature"), oldTip);
  });
}

async function undoUpdate() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    await startBranch(repo, "feature");
    commitFile(directory, "feature.txt", "feature\n", "Feature");
    await commitAndSave(repo);
    const featureBefore = tip(directory, "feature");
    await repo.switch("main");
    commitFile(directory, "parent.txt", "parent\n", "Parent");
    await commitAndSave(repo);
    await repo.switch("feature");
    const updated = await updateFromParent(repo);
    assert.equal(updated.updated, true);
    await undoLastAction(repo);
    assert.equal(tip(directory, "feature"), featureBefore);
    assert.equal(await repo.currentBranch(), "feature");
  });
}

async function undoAfterAbortedMerge() {
  await withFixture(async fixture => {
    const { directory, repo } = await initializedClone(fixture);
    const saved = await commitAndSave(repo);
    const publisher = await fixture.clone("publisher");
    commitFile(directory, "main.txt", "local side\n", "Local side");
    commitFile(publisher.directory, "main.txt", "remote side\n", "Remote side");
    git(publisher.directory, ["push", "origin", "main"]);
    const pending = await reconcileWithRemote(repo);
    assert.equal(pending.pending, true);
    assert.equal(await repo.operationInProgress(), true);
    await abortPendingMerge(repo);
    assert.equal((await readOperationReceipt(repo, pending.operationId)).status, "aborted");
    assert.equal(await repo.operationInProgress(), false);
    const eligibility = await inspectUndoEligibility(repo);
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.operationId, saved.operationId);
    const before = await repositoryState(repo, fixture.remote);
    await expectUndoRefusal(() => undoLastAction(repo));
    assert.deepEqual(await repositoryState(repo, fixture.remote), before);
  });
}

async function run() {
  await undoLegacyInit();
  await undoGet();
  await undoGetCreatedBranch();
  await undoSave();
  await undoDeletedAndBinaryFiles();
  await laterWorkRefusals();
  await undoFinish("retain");
  await undoFinish("delete");
  await undoCondense();
  await undoUpdate();
  await interruptedUndo();
  await undoAfterAbortedMerge();
  console.log("WipStream exact-state Undo tests passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
