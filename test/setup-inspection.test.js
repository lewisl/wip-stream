const assert = require("assert/strict");
const { chmodSync, readFileSync, unlinkSync, writeFileSync } = require("fs");
const path = require("path");
const { createCheckpoint } = require("../out/generalized-workflow");
const { inspectRepositorySetup } = require("../out/setup-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { listOperationReceipts } = require("../out/operations");
const { withRepositoryCommandLock } = require("../out/repository-safety");
const { WipStreamError } = require("../out/errors");
const { git, commitFile, heads, withFixture } = require("./setup-fixture");

async function inspectWithoutMutation() {
  await withFixture(async ({ remote, seed, clone }) => {
    git(seed, ["switch", "-c", "remote-feature"]);
    commitFile(seed, "remote.txt", "remote\n");
    git(seed, ["push", "origin", "remote-feature"]);
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "local-only"]);
    commitFile(local.directory, "committed.txt", "local commit\n");
    // Copied configuration must not hide current repository state.
    git(local.directory, ["config", "wipstream.remote", "origin"]);
    writeFileSync(path.join(local.directory, "main.txt"), "staged\n");
    git(local.directory, ["add", "main.txt"]);
    writeFileSync(path.join(local.directory, "main.txt"), "unstaged\n");
    writeFileSync(path.join(local.directory, "untracked.txt"), "untracked\n");
    writeFileSync(path.join(local.directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(local.directory, "ignored.txt"), "ignored\n");
    const beforeHeads = heads(local.directory);
    const beforeRemote = heads(remote);
    const beforeIndex = readFileSync(path.join(local.directory, ".git", "index"));
    const beforeConfig = readFileSync(path.join(local.directory, ".git", "config"));
    const hooks = { readEditorState: () => ({ signature: "unsaved document version 2", dirty: true }) };
    const inspection = await inspectRepositorySetup(local.repo, undefined, hooks);
    assert.equal(inspection.requiresChoice, true);
    assert.equal(inspection.local.checkout, "local-only");
    assert.equal(inspection.local.editors.dirty, true);
    assert.equal(inspection.remoteDefaultBranch, "main");
    assert.ok(inspection.branches.some(branch => branch.name === "local-only" && branch.relation === "local-only"));
    assert.ok(inspection.branches.some(branch => branch.name === "remote-feature" && branch.relation === "remote-only"));
    assert.equal(heads(local.directory), beforeHeads);
    assert.equal(heads(remote), beforeRemote);
    assert.deepEqual(readFileSync(path.join(local.directory, ".git", "index")), beforeIndex);
    assert.deepEqual(readFileSync(path.join(local.directory, ".git", "config")), beforeConfig);
    assert.equal(readFileSync(path.join(local.directory, "main.txt"), "utf8"), "unstaged\n");
    assert.deepEqual(await listOperationReceipts(local.repo), []);
    writeFileSync(path.join(local.directory, "ignored.txt"), "changed ignored contents\n");
    const second = await inspectRepositorySetup(local.repo, undefined, hooks);
    assert.equal(second.local.status, inspection.local.status);
    assert.equal(second.local.files, inspection.local.files, "ignored activity does not invalidate local-work approval");
    assert.ok(Object.isFrozen(inspection));
  });
}

async function inspectFreshCloneAndActualRemoteDefault() {
  await withFixture(async ({ remote, seed, clone }) => {
    const local = await clone("local");
    assert.equal((await inspectRepositorySetup(local.repo)).requiresChoice, false);
    git(seed, ["switch", "-c", "new-default"]);
    commitFile(seed, "default.txt", "new default\n");
    git(seed, ["push", "origin", "new-default"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/new-default"]);
    assert.equal((await inspectRepositorySetup(local.repo)).remoteDefaultBranch, "new-default", "inspect the server rather than a stale local symbolic HEAD");
    assert.equal(git(local.directory, ["branch", "--show-current"]), "main");
  });
}

async function checkpointBeforeInitialization() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const remoteBefore = heads(remote);
    writeFileSync(path.join(local.directory, "addition.txt"), "addition\n");
    writeFileSync(path.join(local.directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(local.directory, "ignored.txt"), "ignored\n");
    unlinkSync(path.join(local.directory, "main.txt"));
    const checkpoint = await withRepositoryCommandLock(local.repo, "Test Checkpoint", () => createCheckpoint(local.repo, "main", {
      requestCheckpointMessage: async () => "First-machine checkpoint",
    }));
    assert.equal(checkpoint.message, "First-machine checkpoint");
    assert.notEqual(checkpoint.before, checkpoint.after);
    assert.equal(git(local.directory, ["status", "--porcelain"]), "");
    assert.equal(git(local.directory, ["ls-tree", "--name-only", "HEAD"]), ".gitignore\naddition.txt");
    assert.equal(heads(remote), remoteBefore);
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    const noOp = await withRepositoryCommandLock(local.repo, "Test Checkpoint", () => createCheckpoint(local.repo, "main", {
      requestCheckpointMessage: async () => { throw new Error("No-op checkpoint must not prompt"); },
    }));
    assert.equal(noOp, undefined);
  });
}

async function checkpointCancellationAndHookFailure() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(local.directory);
    writeFileSync(path.join(local.directory, "work.txt"), "work\n");
    await assert.rejects(() => withRepositoryCommandLock(local.repo, "Test Checkpoint", () => createCheckpoint(local.repo, "main", {
      requestCheckpointMessage: async () => { throw new WipStreamError("CANCELLED", "Cancelled message"); },
    })), error => error.code === "CANCELLED");
    assert.equal(heads(local.directory), before);
    const hook = path.join(local.directory, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho hook-rejected >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    await assert.rejects(() => withRepositoryCommandLock(local.repo, "Test Checkpoint", () => createCheckpoint(local.repo, "main")), /hook-rejected/);
    assert.equal(heads(local.directory), before);
    assert.equal(heads(remote), before);
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
  });
}

Promise.resolve().then(inspectWithoutMutation).then(inspectFreshCloneAndActualRemoteDefault)
  .then(checkpointBeforeInitialization).then(checkpointCancellationAndHookFailure)
  .then(() => console.log("WipStream setup inspection and shared checkpoint tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
