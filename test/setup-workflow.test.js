const assert = require("assert/strict");
const { chmodSync, readFileSync, unlinkSync, writeFileSync } = require("fs");
const path = require("path");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectIncompleteOperations, readOperationReceipt } = require("../out/operations");
const { recoverIncompleteOperation } = require("../out/recovery-workflow");
const { WipStreamError } = require("../out/errors");
const { git, commitFile, heads, withFixture } = require("./setup-fixture");

const localWork = { kind: "local-work" };
async function setup(repo, hooks = {}) {
  return executeRepositorySetup(repo, await inspectRepositorySetup(repo, undefined, hooks), localWork, hooks);
}

async function dirtyFirstMachine() {
  await withFixture(async ({ seed, remote, clone }) => {
    commitFile(seed, "delete.txt", "delete me\n");
    commitFile(seed, ".gitignore", "ignored.txt\n");
    git(seed, ["push", "origin", "main"]);
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "local-only"]);
    commitFile(local.directory, "committed.txt", "existing local commit\n");
    writeFileSync(path.join(local.directory, "main.txt"), "staged version\n");
    git(local.directory, ["add", "main.txt"]);
    writeFileSync(path.join(local.directory, "main.txt"), "unstaged final version\n");
    writeFileSync(path.join(local.directory, "addition.txt"), "new\n");
    unlinkSync(path.join(local.directory, "delete.txt"));
    writeFileSync(path.join(local.directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(local.directory, "ignored.txt"), "kept locally\n");
    const result = await setup(local.repo, { requestCheckpointMessage: async () => "First machine's work" });
    assert.equal(result.kind, "completed", result.message);
    assert.equal(result.published, true);
    assert.equal(result.checkpointCreated, true);
    assert.deepEqual(result.publishedBranches, ["local-only"]);
    assert.equal(result.checkout, "main");
    assert.equal(heads(local.directory), heads(remote));
    assert.equal(git(remote, ["show", "local-only:main.txt"]), "unstaged final version");
    assert.equal(git(remote, ["show", "local-only:addition.txt"]), "new");
    assert.ok(!git(remote, ["ls-tree", "--name-only", "local-only"]).includes("delete.txt"));
    assert.equal(readFileSync(path.join(local.directory, "ignored.txt"), "utf8"), "kept locally\n");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "initialized", remote: "origin" });
    assert.equal((await readOperationReceipt(local.repo, result.operationId)).plan.checkpoint.message, "First machine's work");
  });
}

async function existingCommitsAndCompatibleRemoteAdvances() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const other = await clone("other");
    git(local.directory, ["switch", "-c", "local-only"]);
    commitFile(local.directory, "local.txt", "local\n");
    commitFile(other.directory, "remote.txt", "remote\n");
    git(other.directory, ["push", "origin", "main"]);
    const result = await setup(local.repo, {
      requestCheckpointMessage: async () => { throw new Error("Existing commits must not prompt for a new checkpoint"); },
    });
    assert.equal(result.kind, "completed");
    assert.equal(result.checkpointCreated, false);
    assert.deepEqual(result.fastForwarded, ["main"]);
    assert.equal(heads(local.directory), heads(remote));
    assert.equal(git(local.directory, ["branch", "--show-current"]), "main");
  });
}

async function divergenceAndExternalMergeRetry() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const other = await clone("other");
    commitFile(other.directory, "remote-side.txt", "remote side\n");
    git(other.directory, ["push", "origin", "main"]);
    git(local.directory, ["branch", "local-only"]);
    writeFileSync(path.join(local.directory, "local-side.txt"), "local side\n");
    const beforeRemote = heads(remote);
    const result = await setup(local.repo, { requestCheckpointMessage: async () => "Retained divergent work" });
    assert.equal(result.kind, "reconciliation-required");
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, false);
    assert.deepEqual(result.branches, ["main"]);
    assert.match(result.message, /checkpoint is saved locally/i);
    assert.match(result.message, /Matching file contents alone/);
    assert.equal(heads(remote), beforeRemote, "divergence prevents publication on every branch");
    assert.equal(git(local.directory, ["log", "-1", "--format=%s"]), "Retained divergent work");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    assert.deepEqual(await inspectIncompleteOperations(local.repo), []);
    // An external Git tool completes reconciliation; Initialize accepts that merge.
    git(local.directory, ["merge", "--no-edit", "origin/main"]);
    const merge = git(local.directory, ["rev-parse", "HEAD"]);
    const retried = await setup(local.repo);
    assert.equal(retried.kind, "completed");
    assert.equal(retried.checkpointCreated, false);
    assert.equal(git(remote, ["rev-parse", "main"]), merge, "reuse the external merge rather than recreate it");
    assert.equal(heads(local.directory), heads(remote));
  });
}

async function documentsSaveRequiresNewPreview() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(remote);
    let dirty = true;
    let version = 1;
    let saved = 0;
    const hooks = {
      readEditorState: () => ({ signature: `document-${version}-${dirty}`, dirty }),
      saveDocuments: async () => {
        saved++;
        if (dirty) {
          writeFileSync(path.join(local.directory, "saved.txt"), "saved buffer\n");
          dirty = false;
          version++;
        }
      },
    };
    const result = await setup(local.repo, hooks);
    assert.equal(result.kind, "preview-required");
    assert.equal(result.checkpointCreated, false);
    assert.equal(heads(local.directory), before);
    assert.equal(heads(remote), before);
    assert.deepEqual(await inspectIncompleteOperations(local.repo), []);
    const retried = await setup(local.repo, hooks);
    assert.equal(retried.kind, "completed");
    assert.equal(retried.checkpointCreated, true);
    assert.equal(git(remote, ["show", "main:saved.txt"]), "saved buffer");
    assert.equal(saved, 2);
  });
}

async function identicalContentsStillRequireHistoryReconciliation() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const other = await clone("other");
    commitFile(local.directory, "main.txt", "same final contents\n", "Local history");
    commitFile(other.directory, "main.txt", "same final contents\n", "Remote history");
    git(other.directory, ["push", "origin", "main"]);
    assert.equal(git(local.directory, ["rev-parse", "HEAD^{tree}"]), git(other.directory, ["rev-parse", "HEAD^{tree}"]));
    const before = heads(remote);
    const result = await setup(local.repo);
    assert.equal(result.kind, "reconciliation-required");
    assert.equal(result.checkpointCreated, false);
    assert.deepEqual(result.branches, ["main"]);
    assert.equal(heads(remote), before);
  });
}

async function postCommitWorktreeChangeRetainsAccurateCheckpointResult() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(remote);
    const hook = path.join(local.directory, ".git", "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf 'generated by hook\\n' > hook-output.txt\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(local.directory, "work.txt"), "checkpoint\n");
    const result = await setup(local.repo);
    assert.equal(result.kind, "failed");
    assert.equal(result.checkpointCreated, true, "a completed checkpoint must not be hidden by a later error");
    assert.match(result.message, /checkpoint is saved locally/i);
    assert.equal(heads(remote), before);
    assert.equal(readFileSync(path.join(local.directory, "hook-output.txt"), "utf8"), "generated by hook\n");
  });
}

async function failedDocumentSave() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(remote);
    writeFileSync(path.join(local.directory, "work.txt"), "work\n");
    const result = await setup(local.repo, {
      saveDocuments: async () => { throw new WipStreamError("SAVE_FAILED", "Editor save failed"); },
    });
    assert.equal(result.kind, "failed");
    assert.equal(result.checkpointCreated, false);
    assert.match(result.message, /Editor save failed/);
    assert.equal(heads(local.directory), before);
    assert.equal(heads(remote), before);
  });
}

async function staleApprovals() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(remote);
    writeFileSync(path.join(local.directory, "work.txt"), "first\n");
    const inspection = await inspectRepositorySetup(local.repo);
    writeFileSync(path.join(local.directory, "work.txt"), "second\n");
    let saved = false;
    const result = await executeRepositorySetup(local.repo, inspection, localWork, { saveDocuments: async () => { saved = true; } });
    assert.equal(result.kind, "preview-required");
    assert.equal(saved, false, "stale state stops before saving documents");
    assert.equal(heads(remote), before);
    const next = await inspectRepositorySetup(local.repo);
    git(local.directory, ["branch", "appeared-after-preview"]);
    assert.equal((await executeRepositorySetup(local.repo, next, localWork)).kind, "preview-required");
    const final = await inspectRepositorySetup(local.repo);
    git(local.directory, ["config", "example.changed", "true"]);
    assert.equal((await executeRepositorySetup(local.repo, final, localWork)).kind, "preview-required");
  });
  await withFixture(async ({ clone }) => {
    const local = await clone("local");
    let editor = "version-1";
    const hooks = { readEditorState: () => ({ signature: editor, dirty: true }) };
    const inspection = await inspectRepositorySetup(local.repo, undefined, hooks);
    editor = "version-2";
    assert.equal((await executeRepositorySetup(local.repo, inspection, localWork, hooks)).kind, "preview-required");
  });
}

async function changedRemoteRequiresPreview() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const other = await clone("other");
    writeFileSync(path.join(local.directory, "work.txt"), "local\n");
    const inspection = await inspectRepositorySetup(local.repo);
    const beforeLocal = heads(local.directory);
    commitFile(other.directory, "remote.txt", "remote\n");
    git(other.directory, ["push", "origin", "main"]);
    const beforeRemote = heads(remote);
    const result = await executeRepositorySetup(local.repo, inspection, localWork);
    assert.equal(result.kind, "preview-required");
    assert.equal(result.checkpointCreated, false);
    assert.equal(heads(local.directory), beforeLocal);
    assert.equal(heads(remote), beforeRemote);
  });
}

async function cancellationAndMessageRace() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    writeFileSync(path.join(local.directory, "work.txt"), "first\n");
    const before = heads(remote);
    const cancelled = await setup(local.repo, {
      requestCheckpointMessage: async () => { throw new WipStreamError("CANCELLED", "Message cancelled"); },
    });
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(cancelled.checkpointCreated, false);
    assert.equal(heads(local.directory), before);
    assert.equal(heads(remote), before);
    const changed = await setup(local.repo, {
      requestCheckpointMessage: async () => {
        writeFileSync(path.join(local.directory, "work.txt"), "changed while prompting\n");
        return "Stale message";
      },
    });
    assert.equal(changed.kind, "preview-required");
    assert.equal(changed.checkpointCreated, false);
    assert.equal(heads(remote), before);
    const inspection = await inspectRepositorySetup(local.repo);
    let saved = false;
    const cancelChoice = await executeRepositorySetup(local.repo, inspection, { kind: "cancel" }, { saveDocuments: async () => { saved = true; } });
    assert.equal(cancelChoice.kind, "cancelled");
    const externalChoice = await executeRepositorySetup(local.repo, inspection, { kind: "reconcile" });
    assert.equal(externalChoice.kind, "reconciliation-required");
    assert.equal(saved, false);
    assert.deepEqual(await inspectIncompleteOperations(local.repo), []);
  });
}

async function rejectedHooksAndAtomicPublication() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const before = heads(remote);
    const hook = path.join(local.directory, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho checkpoint-rejected >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(local.directory, "work.txt"), "work\n");
    const result = await setup(local.repo);
    assert.equal(result.kind, "failed");
    assert.equal(result.checkpointCreated, false);
    assert.match(result.message, /checkpoint-rejected/);
    assert.equal(heads(local.directory), before);
    assert.equal(heads(remote), before);
  });
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const other = await clone("other");
    git(local.directory, ["branch", "companion-local-only"]);
    writeFileSync(path.join(local.directory, "work.txt"), "checkpoint\n");
    const result = await setup(local.repo, {
      beforeRemotePush: async () => {
        commitFile(other.directory, "raced.txt", "remote race\n");
        git(other.directory, ["push", "origin", "main"]);
      },
    });
    assert.equal(result.kind, "failed");
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, false);
    assert.match(result.message, /checkpoint is saved locally/i);
    assert.equal(heads(remote), heads(other.directory), "atomic rejection publishes no companion branch");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    assert.equal((await readOperationReceipt(local.repo, result.operationId)).phase, "before-remote-push");
    await recoverIncompleteOperation(local.repo, result.operationId);
    assert.equal((await setup(local.repo)).kind, "reconciliation-required");
  });
}

async function interruptionAfterSuccessfulPublication() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "work"]);
    writeFileSync(path.join(local.directory, "work.txt"), "saved\n");
    const result = await setup(local.repo, { afterRemotePush: async () => { throw new Error("Interrupted after push"); } });
    assert.equal(result.kind, "failed");
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, false, "a successful push alone is not a completed handoff");
    assert.match(result.message, /after-remote-push/);
    assert.equal(git(remote, ["show", "work:work.txt"]), "saved");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
    await recoverIncompleteOperation(local.repo, result.operationId);
    assert.equal((await setup(local.repo)).kind, "completed");
    assert.equal(heads(local.directory), heads(remote));
  });
}

async function checkpointRetainedAfterCancellation() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    const controller = new AbortController();
    const before = heads(remote);
    writeFileSync(path.join(local.directory, "work.txt"), "saved before cancellation\n");
    const inspection = await inspectRepositorySetup(local.repo);
    const fetch = local.repo.fetchAllBranches.bind(local.repo);
    let fetches = 0;
    local.repo.fetchAllBranches = async (...args) => {
      await fetch(...args);
      if (++fetches === 2) controller.abort();
    };
    const result = await executeRepositorySetup(local.repo, inspection, localWork, { signal: controller.signal });
    assert.equal(result.kind, "cancelled");
    assert.equal(result.checkpointCreated, true);
    assert.match(result.message, /checkpoint is saved locally/i);
    assert.equal(heads(remote), before);
    assert.notEqual(heads(local.directory), before);
  });
}

async function editorChangesBlockLocalReplacementAfterPush() {
  await withFixture(async ({ clone }) => {
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "work"]);
    writeFileSync(path.join(local.directory, "work.txt"), "saved\n");
    let editor = "clean";
    const result = await setup(local.repo, {
      readEditorState: () => ({ signature: editor, dirty: editor !== "clean" }),
      afterRemotePush: async () => { editor = "new unsaved editor change"; },
    });
    assert.equal(result.kind, "failed");
    assert.equal(git(local.directory, ["branch", "--show-current"]), "work", "stop before switching or replacing files");
    assert.match(result.message, /editor documents changed/);
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "uninitialized" });
  });
}

Promise.resolve().then(dirtyFirstMachine).then(existingCommitsAndCompatibleRemoteAdvances)
  .then(divergenceAndExternalMergeRetry).then(identicalContentsStillRequireHistoryReconciliation)
  .then(documentsSaveRequiresNewPreview).then(failedDocumentSave)
  .then(staleApprovals).then(changedRemoteRequiresPreview).then(cancellationAndMessageRace)
  .then(rejectedHooksAndAtomicPublication).then(interruptionAfterSuccessfulPublication)
  .then(checkpointRetainedAfterCancellation).then(editorChangesBlockLocalReplacementAfterPush)
  .then(postCommitWorktreeChangeRetainsAccurateCheckpointResult)
  .then(() => console.log("WipStream local-authority setup and reconciliation tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
