const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");
const { GitRepository } = require("../out/git");
const { commitAndSave, initializeRepository } = require("../out/generalized-workflow");
const { abortPendingMerge, continuePendingMerge, reconcileWithRemote } = require("../out/conflict-workflow");
const { inspectIncompleteOperations, readOperationReceipt, recordPendingMerge } = require("../out/operations");
const { inspectExternalMergeResolution } = require("../out/merge-recovery");
const { recoverIncompleteOperation } = require("../out/recovery-workflow");
const { requireRepositoryPreflight, withRepositoryWorkflow } = require("../out/repository-safety");
const { inspectUndoEligibility } = require("../out/undo-workflow");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(directory, contents, message) {
  writeFileSync(path.join(directory, "shared.txt"), contents);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

async function fixture(action, identical = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wipstream-recovery-"));
  try {
    const remote = path.join(root, "remote.git");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    git(root, ["init", "--bare", remote]);
    git(root, ["init", first]);
    git(first, ["config", "user.name", "WipStream Recovery Test"]);
    git(first, ["config", "user.email", "recovery@example.invalid"]);
    commit(first, "baseline\n", "Baseline");
    git(first, ["branch", "-M", "main"]);
    git(first, ["remote", "add", "origin", remote]);
    git(first, ["push", "-u", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(first, ["remote", "set-head", "origin", "main"]);
    git(root, ["clone", remote, second]);
    git(second, ["config", "user.name", "WipStream Recovery Test"]);
    git(second, ["config", "user.email", "recovery@example.invalid"]);
    const repo = await GitRepository.open(first);
    await initializeRepository(repo);
    commit(first, "local\n", "Local commit from external client");
    commit(second, identical ? "local\n" : "remote\n", "Remote commit");
    git(second, ["push", "origin", "main"]);
    await action({ root, remote, first, second, repo });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function snapshot({ first, remote }) {
  return {
    refs: git(first, ["show-ref"]),
    remote: git(remote, ["show-ref"]),
    status: git(first, ["status", "--porcelain=v1", "--untracked-files=all"]),
    index: git(first, ["ls-files", "--stage"]),
    staged: git(first, ["diff", "--cached", "--binary"]),
    unstaged: git(first, ["diff", "--binary"]),
    shared: readFileSync(path.join(first, "shared.txt"), "utf8"),
  };
}

async function preflight(repo) {
  await withRepositoryWorkflow(repo, "Recovery test", () => requireRepositoryPreflight(repo, {
    command: "Recovery test", cleanWorktree: false, cleanSubmodules: false,
  }));
}

async function externalCompletion(legacy) {
  await fixture(async (f) => {
    const pending = await reconcileWithRemote(f.repo);
    assert.equal(pending.pending, true);
    let receipt = await readOperationReceipt(f.repo, pending.operationId);
    assert.equal(receipt.pendingMerge.mergeTargetCommit, git(f.second, ["rev-parse", "HEAD"]));
    if (legacy) {
      // Model the public receipt format written by 0.2.5 through its receipt API.
      await recordPendingMerge(f.repo, pending.operationId, { ...receipt.pendingMerge, mergeTargetCommit: undefined });
    }
    commit(f.first, "resolved merge\n", "Merge completed in another Git client");
    const mergeCommit = git(f.first, ["rev-parse", "HEAD"]);
    git(f.first, ["push", "origin", "main"]);
    commit(f.first, "later committed correction\n", "Later external commit");
    writeFileSync(path.join(f.first, "shared.txt"), "staged correction\n");
    git(f.first, ["add", "shared.txt"]);
    writeFileSync(path.join(f.first, "shared.txt"), "working correction\n");
    writeFileSync(path.join(f.first, "untracked.txt"), "preserve untracked bytes\n");
    const before = snapshot(f);
    receipt = await readOperationReceipt(f.repo, pending.operationId);
    assert.equal((await inspectExternalMergeResolution(f.repo, receipt)).mergeCommit, mergeCommit);
    assert.equal((await readOperationReceipt(f.repo, pending.operationId)).status, "in-progress", "inspection is read-only");
    await preflight(f.repo);
    assert.deepEqual(snapshot(f), before, "automatic recovery preserves refs, staged content and working content");
    assert.equal(readFileSync(path.join(f.first, "untracked.txt"), "utf8"), "preserve untracked bytes\n");
    const recovered = await readOperationReceipt(f.repo, pending.operationId);
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recovery.resolution, "merge-completed-externally");
    assert.equal(recovered.recovery.mergeCommit, mergeCommit);
    assert.deepEqual(recovered.plan, receipt.plan);
    assert.deepEqual(recovered.events.slice(0, -1), receipt.events);
    assert.equal((await inspectUndoEligibility(f.repo)).reason, "The latest operation is not undoable.");
    assert.deepEqual(await inspectIncompleteOperations(f.repo), []);
    assert.equal((await commitAndSave(f.repo)).published, true);
    assert.equal(git(f.first, ["rev-parse", "HEAD"]), git(f.remote, ["rev-parse", "main"]));
  });
}

async function externalAbort() {
  for (const viaAbort of [false, true]) {
    await fixture(async (f) => {
      const pending = await reconcileWithRemote(f.repo);
      git(f.first, ["merge", "--abort"]);
      const before = snapshot(f);
      if (viaAbort) assert.equal((await abortPendingMerge(f.repo)).restored, true);
      else await preflight(f.repo);
      assert.deepEqual(snapshot(f), before);
      assert.equal((await readOperationReceipt(f.repo, pending.operationId)).recovery.resolution, "merge-aborted-externally");
    });
  }
}

async function externalCompletionViaMergeCommands() {
  for (const action of ["continue", "abort"]) {
    await fixture(async (f) => {
      const pending = await reconcileWithRemote(f.repo);
      commit(f.first, "resolved outside WipStream\n", "External merge commit");
      const before = snapshot(f);
      if (action === "continue") {
        assert.equal((await continuePendingMerge(f.repo)).save.published, true);
        assert.equal(git(f.first, ["rev-parse", "HEAD"]), git(f.remote, ["rev-parse", "main"]));
      } else {
        assert.equal((await abortPendingMerge(f.repo)).restored, false,
          "Abort must not claim to undo an already completed merge");
        assert.deepEqual(snapshot(f), before);
      }
      assert.equal((await readOperationReceipt(f.repo, pending.operationId)).recovery.resolution, "merge-completed-externally");
    });
  }
}

async function uncertainRecovery() {
  await fixture(async (f) => {
    const pending = await reconcileWithRemote(f.repo);
    await assert.rejects(() => recoverIncompleteOperation(f.repo, pending.operationId), { code: "GIT_OPERATION_IN_PROGRESS" });
    git(f.first, ["merge", "--quit"]);
    await assert.rejects(() => recoverIncompleteOperation(f.repo, pending.operationId), { code: "UNRESOLVED_CONFLICTS" });
    writeFileSync(path.join(f.first, "shared.txt"), "manual final repair\n");
    git(f.first, ["add", "shared.txt"]);
    writeFileSync(path.join(f.first, "shared.txt"), "later working repair\n");
    const before = snapshot(f);
    await assert.rejects(() => preflight(f.repo), { code: "INCOMPLETE_WIPSTREAM_OPERATION" });
    await assert.rejects(() => abortPendingMerge(f.repo), { code: "MERGE_STATE_MISSING" });
    await recoverIncompleteOperation(f.repo, pending.operationId);
    assert.deepEqual(snapshot(f), before);
    assert.equal((await readOperationReceipt(f.repo, pending.operationId)).recovery.resolution, "kept-current-state");
    await assert.rejects(() => recoverIncompleteOperation(f.repo, pending.operationId), { code: "OPERATION_NOT_IN_PROGRESS" });
    const saved = await commitAndSave(f.repo);
    assert.equal(saved.failure, "unsafe-branches", "recovery does not claim remote synchronization");
  });
}

async function unrelatedActiveOperation() {
  await fixture(async (f) => {
    await reconcileWithRemote(f.repo);
    git(f.first, ["merge", "--abort"]);
    assert.throws(() => git(f.first, ["cherry-pick", "origin/main"]));
    writeFileSync(path.join(f.first, "shared.txt"), "resolved cherry pick\n");
    git(f.first, ["add", "shared.txt"]);
    const before = snapshot(f);
    await assert.rejects(() => abortPendingMerge(f.repo), { code: "MERGE_STATE_MISMATCH" });
    await assert.rejects(() => continuePendingMerge(f.repo), { code: "MERGE_STATE_MISMATCH" });
    assert.deepEqual(snapshot(f), before);
    assert.equal(await f.repo.refExists("CHERRY_PICK_HEAD"), true);
  });
}

async function identicalTreesAndInterruptedCompletion() {
  await fixture(async (f) => {
    const localTip = git(f.first, ["rev-parse", "HEAD"]);
    const remoteTip = git(f.second, ["rev-parse", "HEAD"]);
    assert.notEqual(localTip, remoteTip);
    const tree = git(f.first, ["rev-parse", "HEAD^{tree}"]);
    assert.equal(tree, git(f.second, ["rev-parse", "HEAD^{tree}"]));
    const merge = f.repo.merge.bind(f.repo);
    f.repo.merge = async (target) => {
      await merge(target);
      throw new Error("Interrupted after Git completed the merge");
    };
    await assert.rejects(() => reconcileWithRemote(f.repo), /Interrupted after Git/);
    const [receipt] = await inspectIncompleteOperations(f.repo);
    assert.equal(receipt.phase, "before-merge");
    assert.equal(receipt.pendingMerge.mergeTargetCommit, remoteTip);
    assert.deepEqual(await f.repo.conflictPaths(), []);
    assert.equal((await commitAndSave(f.repo)).published, true, "Save automatically closes the stale receipt");
    assert.equal(git(f.first, ["rev-parse", "HEAD^{tree}"]), tree);
    assert.equal(await f.repo.isAncestor(localTip, "HEAD"), true);
    assert.equal(await f.repo.isAncestor(remoteTip, "HEAD"), true);
  }, true);
}

async function pendingTargetMoves() {
  await fixture(async (f) => {
    const pending = await reconcileWithRemote(f.repo);
    const target = git(f.second, ["rev-parse", "HEAD"]);
    commit(f.second, "new remote advance\n", "Remote moves after merge started");
    git(f.second, ["push", "origin", "main"]);
    git(f.first, ["fetch", "origin"]);
    commit(f.first, "resolved original merge\n", "External resolution");
    await preflight(f.repo);
    const receipt = await readOperationReceipt(f.repo, pending.operationId);
    assert.equal(receipt.status, "recovered");
    assert.equal(receipt.pendingMerge.mergeTargetCommit, target);
    assert.notEqual(target, git(f.first, ["rev-parse", "origin/main"]));
  });
}

Promise.resolve()
  .then(() => externalCompletion(false))
  .then(() => externalCompletion(true))
  .then(externalAbort)
  .then(externalCompletionViaMergeCommands)
  .then(uncertainRecovery)
  .then(unrelatedActiveOperation)
  .then(identicalTreesAndInterruptedCompletion)
  .then(pendingTargetMoves)
  .then(() => console.log("WipStream external merge and recovery tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
