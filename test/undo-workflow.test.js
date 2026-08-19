const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");
const { GitRepository } = require("../out/git");
const { commitAndSave, getFromRemote, initializeRepository } = require("../out/generalized-workflow");
const { condenseBranch, finishBranch, startBranch, updateFromParent } = require("../out/lifecycle-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectIncompleteOperations } = require("../out/operations");
const { UndoWorkflowError, inspectUndoEligibility, undoLastAction } = require("../out/undo-workflow");

function git(cwd, args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function identity(dir) { git(dir, ["config", "user.name", "Undo Test"]); git(dir, ["config", "user.email", "undo@example.invalid"]); }
function make(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix)); const remote = path.join(root, "remote.git"); const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]); git(root, ["init", seed]); identity(seed);
  writeFileSync(path.join(seed, "base.txt"), "base\n"); git(seed, ["add", "."]); git(seed, ["commit", "-m", "base"]); git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]); git(seed, ["push", "-u", "origin", "main"]); git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote, seed };
}
async function use(prefix, fn) { const f = make(prefix); try { await fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); } }
async function clone(f, name, init = false) { const dir = path.join(f.root, name); git(f.root, ["clone", f.remote, dir]); identity(dir); const repo = await GitRepository.open(dir); if (init) await initializeRepository(repo); return { dir, repo }; }
function commit(dir, file, text, msg) { writeFileSync(path.join(dir, file), text); git(dir, ["add", "--all"]); git(dir, ["commit", "-m", msg]); }
function tip(dir, branch) { return git(dir, ["rev-parse", `refs/heads/${branch}`]); }
function exists(dir, branch) { try { tip(dir, branch); return true; } catch { return false; } }
async function expectUndoRefusal(action) { await assert.rejects(action, (e) => e instanceof UndoWorkflowError && e.code === "UNDO_NOT_ELIGIBLE"); }

async function undoInit() {
  await use("undo-init-", async (f) => {
    git(f.seed, ["switch", "-c", "topic"]); commit(f.seed, "topic.txt", "topic\n", "topic"); git(f.seed, ["push", "-u", "origin", "topic"]);
    const c = await clone(f, "clone"); const result = await initializeRepository(c.repo);
    assert.equal(exists(c.dir, "topic"), true); assert.equal((await inspectUndoEligibility(c.repo)).operationId, result.operationId);
    await undoLastAction(c.repo); assert.equal(exists(c.dir, "topic"), false); assert.deepEqual(await readRepositoryConfiguration(c.repo), { kind: "uninitialized" });
  });
}

async function undoGet() {
  await use("undo-get-", async (f) => {
    const c = await clone(f, "clone", true); const before = tip(c.dir, "main"); const p = await clone(f, "publisher");
    commit(p.dir, "advance.txt", "advance\n", "advance"); git(p.dir, ["push", "origin", "main"]);
    const result = await getFromRemote(c.repo); assert.notEqual(tip(c.dir, "main"), before); assert.equal((await inspectUndoEligibility(c.repo)).operationId, result.operationId);
    await undoLastAction(c.repo); assert.equal(tip(c.dir, "main"), before); assert.equal(git(c.dir, ["branch", "--show-current"]), "main");
  });
}

async function undoSaveAndRefusals() {
  await use("undo-save-", async (f) => {
    const c = await clone(f, "clone", true); const before = tip(c.dir, "main"); writeFileSync(path.join(c.dir, "saved.txt"), "saved content\n");
    const saved = await commitAndSave(c.repo, { requestCheckpointMessage: async () => "checkpoint" }); assert.equal(saved.published, true);
    const undone = await undoLastAction(c.repo); assert.equal(undone.restoredCheckpoint, true); assert.equal(tip(c.dir, "main"), before);
    assert.equal(readFileSync(path.join(c.dir, "saved.txt"), "utf8"), "saved content\n"); assert.match(git(c.dir, ["status", "--porcelain"]), /saved\.txt/);
    await expectUndoRefusal(() => undoLastAction(c.repo));
  });
  await use("undo-later-local-", async (f) => {
    const c = await clone(f, "clone", true); writeFileSync(path.join(c.dir, "x.txt"), "x\n"); await commitAndSave(c.repo); commit(c.dir, "later.txt", "later\n", "later");
    assert.equal((await inspectUndoEligibility(c.repo)).eligible, false); await expectUndoRefusal(() => undoLastAction(c.repo));
  });
  await use("undo-later-worktree-", async (f) => {
    const c = await clone(f, "clone", true); writeFileSync(path.join(c.dir, "x.txt"), "x\n"); await commitAndSave(c.repo); writeFileSync(path.join(c.dir, "later.txt"), "later\n");
    assert.equal((await inspectUndoEligibility(c.repo)).eligible, false); await expectUndoRefusal(() => undoLastAction(c.repo));
  });
  await use("undo-later-remote-", async (f) => {
    const c = await clone(f, "clone", true); writeFileSync(path.join(c.dir, "x.txt"), "x\n"); await commitAndSave(c.repo); const p = await clone(f, "publisher");
    commit(p.dir, "later.txt", "later\n", "later"); git(p.dir, ["push", "origin", "main"]);
    await assert.rejects(() => undoLastAction(c.repo), (e) => e instanceof UndoWorkflowError && e.code === "REMOTE_CHANGED_AFTER_OPERATION");
  });
}

async function interruptedUndo() {
  await use("undo-interrupted-", async (f) => {
    const c = await clone(f, "clone", true); writeFileSync(path.join(c.dir, "x.txt"), "x\n"); await commitAndSave(c.repo);
    await assert.rejects(() => undoLastAction(c.repo, { afterRemotePush: async () => { throw new Error("interrupt undo"); } }), /interrupt undo/);
    const incomplete = await inspectIncompleteOperations(c.repo); assert.equal(incomplete.length, 1); assert.equal(incomplete[0].phase, "after-remote-push");
    assert.match(incomplete[0].plan.command, /^Undo Commit and Save$/);
  });
}

async function undoFinish(disposition) {
  await use(`undo-finish-${disposition}-`, async (f) => {
    const c = await clone(f, "clone", true); const mainBefore = tip(c.dir, "main"); await startBranch(c.repo, "feature");
    writeFileSync(path.join(c.dir, "feature.txt"), "feature\n"); const finished = await finishBranch(c.repo, { save: { requestCheckpointMessage: async () => "feature" }, chooseDisposition: async () => disposition });
    await undoLastAction(c.repo); assert.equal(tip(c.dir, "main"), mainBefore); assert.equal(git(c.dir, ["branch", "--show-current"]), "feature");
    assert.equal(exists(c.dir, "feature"), true); assert.equal(exists(f.remote, "feature"), true);
    if (disposition === "delete") assert.equal(git(c.dir, ["config", "--get", "branch.feature.wipstreamParent"]), "main");
    assert.equal(finished.branch, "feature");
  });
}

async function undoCondenseAndUpdate() {
  await use("undo-condense-", async (f) => {
    const c = await clone(f, "clone", true); await startBranch(c.repo, "feature"); commit(c.dir, "one.txt", "1\n", "one"); commit(c.dir, "two.txt", "2\n", "two"); await commitAndSave(c.repo);
    const old = tip(c.dir, "feature"); await condenseBranch(c.repo, { confirmPreview: async () => true, requestMessage: async () => "condensed" }); await undoLastAction(c.repo);
    assert.equal(tip(c.dir, "feature"), old); assert.equal(tip(f.remote, "feature"), old);
  });
  await use("undo-update-", async (f) => {
    const c = await clone(f, "clone", true); await startBranch(c.repo, "feature"); commit(c.dir, "feature.txt", "feature\n", "feature"); await commitAndSave(c.repo); const featureBefore = tip(c.dir, "feature");
    git(c.dir, ["switch", "main"]); commit(c.dir, "parent.txt", "parent\n", "parent"); await commitAndSave(c.repo); git(c.dir, ["switch", "feature"]); const updated = await updateFromParent(c.repo); assert.equal(updated.updated, true);
    await undoLastAction(c.repo); assert.equal(tip(c.dir, "feature"), featureBefore); assert.equal(git(c.dir, ["branch", "--show-current"]), "feature");
  });
}

Promise.resolve().then(undoInit).then(undoGet).then(undoSaveAndRefusals).then(() => undoFinish("retain")).then(() => undoFinish("delete")).then(undoCondenseAndUpdate).then(interruptedUndo)
  .then(() => console.log("WipStream exact-state Undo tests passed."))
  .catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
