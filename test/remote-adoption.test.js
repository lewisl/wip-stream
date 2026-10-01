const assert = require("assert/strict");
const { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } = require("fs");
const path = require("path");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectIncompleteOperations, listOperationReceipts, readOperationReceipt, recoveryRef, renderOperationPreview } = require("../out/operations");
const { inspectUndoEligibility } = require("../out/undo-workflow");
const { git, commitFile, heads, withFixture } = require("./setup-fixture");

const discard = { kind: "remote", backup: { kind: "discard", confirmed: true } };
function forbidPublishingAndCommitting(repo) {
  for (const method of ["pushRefsAtomic", "pushAtomic", "verifyAtomicPushSupport", "commit", "createCommitFromTree", "merge"]) {
    repo[method] = async () => { throw new Error(`Remote adoption must never call ${method}`); };
  }
}
async function adopt(local, choice = discard) {
  const inspection = await inspectRepositorySetup(local.repo);
  forbidPublishingAndCommitting(local.repo);
  return executeRepositorySetup(local.repo, inspection, choice);
}

async function allBranchAuthorityWithBackup() {
  await withFixture(async ({ root, remote, seed, clone }) => {
    commitFile(seed, ".gitignore", "ignored/\n");
    for (const branch of ["ahead", "behind", "diverged", "identical", "local.foo"]) {
      git(seed, ["branch", branch]);
      git(seed, ["push", "origin", branch]);
    }
    git(seed, ["push", "origin", "main"]);
    const local = await clone("local");
    for (const branch of ["ahead", "behind", "diverged", "identical", "local.foo"]) git(local.directory, ["branch", "--track", branch, `origin/${branch}`]);
    for (const branch of ["ahead", "diverged"]) {
      git(local.directory, ["switch", branch]);
      commitFile(local.directory, `${branch}-local.txt`, "local history\n", `Local ${branch}`);
    }
    git(local.directory, ["switch", "identical"]);
    commitFile(local.directory, "identical.txt", "same final contents\n", "Local identical history");
    git(local.directory, ["switch", "-c", "local", "main"]);
    commitFile(local.directory, "local-only.txt", "local only history\n");
    git(local.directory, ["config", "branch.local.wipstreamParent", "main"]);
    git(local.directory, ["config", "branch.local.foo.custom", "preserve similar branch config"]);
    git(local.directory, ["config", "example.unrelated", "preserve unrelated config"]);
    git(local.directory, ["tag", "local-tag"]);
    writeFileSync(path.join(local.directory, "main.txt"), "staged local work\n");
    git(local.directory, ["add", "main.txt"]);
    writeFileSync(path.join(local.directory, "main.txt"), "unstaged local work\n");
    writeFileSync(path.join(local.directory, "untracked space\nand newline.txt"), "untracked\n");
    mkdirSync(path.join(local.directory, "ignored"));
    writeFileSync(path.join(local.directory, "ignored", "cache.txt"), "ignored content\n");
    const beforeHeads = heads(local.directory);
    const beforeTag = git(local.directory, ["rev-parse", "local-tag"]);
    const other = await clone("other");
    for (const branch of ["behind", "diverged", "identical"]) {
      git(other.directory, ["switch", branch]);
      commitFile(other.directory, branch === "identical" ? "identical.txt" : `${branch}-remote.txt`, branch === "identical" ? "same final contents\n" : "remote history\n", `Remote ${branch}`);
      git(other.directory, ["push", "origin", branch]);
    }
    git(other.directory, ["switch", "main"]);
    git(other.directory, ["switch", "-c", "remote-only"]);
    commitFile(other.directory, "remote-only.txt", "remote-only branch\n");
    git(other.directory, ["push", "origin", "remote-only"]);
    const beforeRemote = heads(remote);
    const result = await adopt(local, { kind: "remote", backup: { kind: "copy", parent: root } });
    assert.equal(result.kind, "completed", result.message);
    assert.equal(result.published, false);
    assert.equal(result.checkpointCreated, false);
    assert.equal(result.checkout, "main");
    assert.equal(heads(local.directory), beforeRemote);
    assert.equal(heads(remote), beforeRemote, "adoption never changes any remote branch");
    assert.equal(heads(result.backupPath), beforeHeads, "all original local history remains in the ordinary backup");
    assert.equal(readFileSync(path.join(result.backupPath, "main.txt"), "utf8"), "unstaged local work\n");
    assert.equal(git(result.backupPath, ["show", ":main.txt"]), "staged local work");
    assert.equal(readFileSync(path.join(result.backupPath, "untracked space\nand newline.txt"), "utf8"), "untracked\n");
    assert.equal(readFileSync(path.join(local.directory, "ignored", "cache.txt"), "utf8"), "ignored content\n");
    assert.equal(git(local.directory, ["rev-parse", "local-tag"]), beforeTag);
    assert.equal(git(local.directory, ["config", "example.unrelated"]), "preserve unrelated config");
    assert.equal(git(local.directory, ["config", "branch.local.foo.custom"]), "preserve similar branch config");
    assert.deepEqual(await local.repo.branchConfigurationKeys("local"), []);
  });
}

async function confirmedDiscardAndReceipt() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    commitFile(local.directory, "committed.txt", "discarded history\n");
    const oldTip = git(local.directory, ["rev-parse", "HEAD"]);
    unlinkSync(path.join(local.directory, "main.txt"));
    writeFileSync(path.join(local.directory, "untracked.txt"), "discarded file\n");
    const beforeRemote = heads(remote);
    const result = await adopt(local);
    assert.equal(result.kind, "completed", result.message);
    assert.equal(heads(remote), beforeRemote);
    const receipt = await readOperationReceipt(local.repo, result.operationId);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(receipt.plan.remoteAdoption.backup, { kind: "explicit-discard" });
    assert.ok(receipt.plan.remoteAdoption.removedUntrackedPaths.includes("untracked.txt"));
    assert.ok(receipt.events.some(event => event.phase === "before-file-replacement"));
    assert.ok(receipt.events.some(event => event.phase === "after-file-replacement"));
    assert.equal(git(local.directory, ["rev-parse", recoveryRef(result.operationId, 0)]), oldTip);
    assert.equal((await inspectUndoEligibility(local.repo)).eligible, false);
    assert.match(renderOperationPreview(receipt.plan), /No push or content commit/);
    assert.equal(git(local.directory, ["status", "--porcelain"]), "");
    assert.deepEqual(await readRepositoryConfiguration(local.repo), { kind: "initialized", remote: "origin" });
  });
}

async function ignoredCollisionsStopBeforeMutation() {
  for (const type of ["same-path", "remote-file-parent", "ignored-link-parent"]) {
    await withFixture(async ({ root, remote, seed, clone }) => {
      const local = await clone("local");
      if (type === "same-path") {
        writeFileSync(path.join(local.directory, ".gitignore"), "collision.txt\n");
        writeFileSync(path.join(local.directory, "collision.txt"), "keep ignored work\n");
        commitFile(seed, "collision.txt", "remote contents\n");
      } else if (type === "remote-file-parent") {
        writeFileSync(path.join(local.directory, ".gitignore"), "cache/\n");
        mkdirSync(path.join(local.directory, "cache"));
        writeFileSync(path.join(local.directory, "cache", "keep.txt"), "keep ignored work\n");
        commitFile(seed, "cache", "remote file replaces directory\n");
      } else {
        const { symlinkSync } = require("fs");
        writeFileSync(path.join(local.directory, ".gitignore"), "cache\n");
        symlinkSync(root, path.join(local.directory, "cache"));
        mkdirSync(path.join(seed, "cache"));
        commitFile(seed, "cache/remote.txt", "remote child\n");
      }
      git(seed, ["push", "origin", "main"]);
      const beforeLocal = heads(local.directory);
      const beforeRemote = heads(remote);
      const result = await adopt(local);
      assert.equal(result.kind, "failed");
      assert.match(result.message, /overwrite ignored local work/);
      assert.equal(heads(local.directory), beforeLocal);
      assert.equal(heads(remote), beforeRemote);
      assert.deepEqual(await listOperationReceipts(local.repo), [], "collision blocks before creating a destructive receipt");
    });
  }
}

async function staleDiscardPreviewAndNoConfirmation() {
  await withFixture(async ({ remote, clone }) => {
    const local = await clone("local");
    writeFileSync(path.join(local.directory, "work.txt"), "first\n");
    const inspection = await inspectRepositorySetup(local.repo);
    writeFileSync(path.join(local.directory, "work.txt"), "changed after preview\n");
    const result = await executeRepositorySetup(local.repo, inspection, discard);
    assert.equal(result.kind, "preview-required");
    assert.equal(heads(local.directory), heads(remote));
    assert.equal(readFileSync(path.join(local.directory, "work.txt"), "utf8"), "changed after preview\n");
    const refused = await executeRepositorySetup(local.repo, await inspectRepositorySetup(local.repo), { kind: "remote", backup: { kind: "discard", confirmed: false } });
    assert.equal(refused.kind, "failed");
    assert.match(refused.message, /Explicit confirmation/);
    assert.deepEqual(await inspectIncompleteOperations(local.repo), []);
  });
}

async function changedDefaultBranchAndCopiedMarker() {
  await withFixture(async ({ remote, seed, clone }) => {
    const local = await clone("local");
    git(local.directory, ["config", "wipstream.remote", "origin"]);
    writeFileSync(path.join(local.directory, "work.txt"), "copied dirty work\n");
    git(seed, ["switch", "-c", "new-default"]);
    commitFile(seed, "new-default.txt", "new default\n");
    git(seed, ["push", "origin", "new-default"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/new-default"]);
    const result = await adopt(local);
    assert.equal(result.kind, "completed", result.message);
    assert.equal(result.checkout, "new-default");
    assert.equal(git(local.directory, ["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/new-default");
    assert.equal(heads(local.directory), heads(remote));
  });
}

async function directoryCleanupRefusesExternalParents() {
  await withFixture(async ({ root, clone }) => {
    const local = await clone("local");
    const outside = path.join(root, "outside-project");
    const empty = path.join(outside, "empty");
    mkdirSync(empty, { recursive: true });
    const keepFile = path.join(outside, "keep.txt");
    writeFileSync(keepFile, "outside the project\n");
    // Model a parent directory replaced by a link after its paths were approved.
    symlinkSync(outside, path.join(local.directory, "changed-parent"), "dir");
    await assert.rejects(local.repo.removeWorkingFiles(["changed-parent/keep.txt"], []),
      error => error.code === "REPLACEMENT_PATH_CHANGED");
    assert.equal(existsSync(keepFile), true, "file cleanup must never follow an external parent link");
    await assert.rejects(local.repo.removeWorkingFiles([], ["changed-parent/empty"]),
      error => error.code === "REPLACEMENT_PATH_CHANGED");
    assert.equal(existsSync(empty), true, "cleanup must never follow a parent link outside the project");
  });
}

Promise.resolve().then(allBranchAuthorityWithBackup).then(confirmedDiscardAndReceipt)
  .then(ignoredCollisionsStopBeforeMutation).then(staleDiscardPreviewAndNoConfirmation)
  .then(changedDefaultBranchAndCopiedMarker)
  .then(directoryCleanupRefusesExternalParents)
  .then(() => console.log("WipStream recorded remote-authority setup tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
