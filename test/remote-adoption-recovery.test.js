const assert = require("assert/strict");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { recoverIncompleteOperation } = require("../out/recovery-workflow");
const { inspectIncompleteOperations, readOperationReceipt, renderOperationPreview } = require("../out/operations");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectUndoEligibility, undoLastAction } = require("../out/undo-workflow");
const { git, commitFile, heads, withFixture } = require("./setup-fixture");

async function interruptedAdoption(method, after, expectedPhase) {
  await withFixture(async ({ root, remote, seed, clone }) => {
    commitFile(seed, ".gitignore", "ignored/\n");
    git(seed, ["push", "origin", "main"]);
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "local-only"]);
    commitFile(local.directory, "local-history.txt", "history retained\n");
    writeFileSync(path.join(local.directory, "main.txt"), "dirty tracked work retained in backup\n");
    writeFileSync(path.join(local.directory, "untracked.txt"), "untracked work retained in backup\n");
    mkdirSync(path.join(local.directory, "ignored"));
    writeFileSync(path.join(local.directory, "ignored", "cache.txt"), "ignored work\n");
    const beforeRemote = heads(remote);
    const inspection = await inspectRepositorySetup(local.repo);
    const original = local.repo[method].bind(local.repo);
    local.repo[method] = async (...args) => {
      if (after) await original(...args);
      throw new Error(`Injected ${after ? "after" : "before"} ${method}`);
    };
    const result = await executeRepositorySetup(local.repo, inspection, { kind: "remote", backup: { kind: "copy", parent: root } });
    assert.equal(result.kind, "failed");
    assert.equal(result.published, false);
    assert.equal(result.checkpointCreated, false);
    assert.ok(existsSync(result.backupPath));
    assert.equal(readFileSync(path.join(result.backupPath, "main.txt"), "utf8"), "dirty tracked work retained in backup\n");
    assert.equal(readFileSync(path.join(result.backupPath, "untracked.txt"), "utf8"), "untracked work retained in backup\n");
    const receipt = await readOperationReceipt(local.repo, result.operationId);
    assert.equal(receipt.phase, expectedPhase);
    assert.equal(receipt.plan.remoteAdoption.backup.path, result.backupPath);
    assert.match(renderOperationPreview(receipt.plan), new RegExp(path.basename(result.backupPath)));
    assert.equal((await inspectIncompleteOperations(local.repo)).length, 1);
    assert.equal(heads(remote), beforeRemote);
    assert.equal((await inspectUndoEligibility(local.repo)).eligible, false);
    await assert.rejects(() => inspectRepositorySetup(local.repo), error => error.code === "INCOMPLETE_WIPSTREAM_OPERATION");
    local.repo[method] = original;
    const currentRefs = heads(local.directory);
    const currentStatus = git(local.directory, ["status", "--porcelain"]);
    const currentHead = git(local.directory, ["rev-parse", "HEAD"]);
    const recovered = await recoverIncompleteOperation(local.repo, result.operationId);
    assert.equal(recovered.status, "recovered");
    assert.equal(heads(local.directory), currentRefs);
    assert.equal(git(local.directory, ["status", "--porcelain"]), currentStatus);
    assert.equal(git(local.directory, ["rev-parse", "HEAD"]), currentHead);
    assert.equal(heads(remote), beforeRemote);
    // Reinspect actual refs/files rather than replay the interrupted receipt.
    const fresh = await inspectRepositorySetup(local.repo);
    if (!fresh.local.checkout) assert.equal(fresh.requiresChoice, true, "a detached recovery requires an explicit authority choice");
    const retry = await executeRepositorySetup(local.repo, fresh, { kind: "remote", backup: { kind: "copy", parent: root } });
    assert.equal(retry.kind, "completed", retry.message);
    assert.equal(heads(local.directory), beforeRemote);
    assert.equal(heads(remote), beforeRemote);
    assert.equal(git(local.directory, ["branch", "--show-current"]), "main");
    assert.ok(existsSync(result.backupPath), "recovery and retry never delete the original backup");
    const undo = await inspectUndoEligibility(local.repo);
    assert.equal(undo.eligible, false);
    assert.match(undo.reason, /refs cannot restore discarded uncommitted files/);
    await assert.rejects(() => undoLastAction(local.repo), error => error.code === "UNDO_NOT_ELIGIBLE");
  });
}

async function changedRemoteAndIgnoredWorkPreventCompletion() {
  await withFixture(async ({ root, remote, seed, clone }) => {
    const local = await clone("local");
    const replace = local.repo.replaceWorkingFiles.bind(local.repo);
    local.repo.replaceWorkingFiles = async commit => {
      await replace(commit);
      commitFile(seed, "changed-remote.txt", "remote changed during adoption\n");
      git(seed, ["push", "origin", "main"]);
    };
    const result = await executeRepositorySetup(local.repo, await inspectRepositorySetup(local.repo), { kind: "remote", backup: { kind: "copy", parent: root } });
    assert.equal(result.kind, "failed");
    assert.match(result.message, /remote changed during replacement/i);
    assert.equal((await readOperationReceipt(local.repo, result.operationId)).phase, "after-remote-fetch");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    assert.ok(existsSync(result.backupPath));
    assert.notEqual(heads(local.directory), heads(remote));
  });
  await withFixture(async ({ root, seed, clone }) => {
    commitFile(seed, ".gitignore", "ignored.txt\n");
    git(seed, ["push", "origin", "main"]);
    const local = await clone("local");
    writeFileSync(path.join(local.directory, "ignored.txt"), "approved ignored contents\n");
    const replace = local.repo.replaceWorkingFiles.bind(local.repo);
    local.repo.replaceWorkingFiles = async commit => {
      await replace(commit);
      writeFileSync(path.join(local.directory, "ignored.txt"), "concurrent ignored change\n");
    };
    const result = await executeRepositorySetup(local.repo, await inspectRepositorySetup(local.repo), { kind: "remote", backup: { kind: "copy", parent: root } });
    assert.equal(result.kind, "failed");
    assert.match(result.message, /Ignored files or their permissions changed/);
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    assert.equal(readFileSync(path.join(result.backupPath, "ignored.txt"), "utf8"), "approved ignored contents\n");
  });
}

Promise.resolve()
  .then(() => interruptedAdoption("removeWorkingFiles", false, "before-file-replacement"))
  .then(() => interruptedAdoption("replaceWorkingFiles", true, "before-file-replacement"))
  .then(() => interruptedAdoption("updateRefs", false, "before-local-refs"))
  .then(() => interruptedAdoption("updateRefs", true, "before-local-refs"))
  .then(() => interruptedAdoption("switch", false, "before-checkout"))
  .then(() => interruptedAdoption("switch", true, "before-checkout"))
  .then(() => interruptedAdoption("setRemoteTrackingDefaultBranch", false, "before-remote-head"))
  .then(() => interruptedAdoption("replaceConfigValues", false, "before-configuration"))
  .then(() => interruptedAdoption("replaceConfigValues", true, "before-configuration"))
  .then(changedRemoteAndIgnoredWorkPreventCompletion)
  .then(() => console.log("WipStream remote-adoption interruption, recovery, and Undo tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
