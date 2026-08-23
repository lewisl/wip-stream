const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitError, GitRepository } = require("../out/git");
const { commitAndSave, initializeRepository } = require("../out/generalized-workflow");
const { inspectIncompleteOperations, readOperationReceipt, recoveryRef } = require("../out/operations");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Save Test"]);
  git(directory, ["config", "user.email", "wipstream-save@example.invalid"]);
}

function createFixture(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", seed]);
  configureIdentity(seed);
  writeFileSync(path.join(seed, "main.txt"), "main baseline\n");
  git(seed, ["add", "main.txt"]);
  git(seed, ["commit", "-m", "Initial commit"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote, seed };
}

async function withFixture(prefix, action) {
  const fixture = createFixture(prefix);
  try {
    await action(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function commitFile(directory, name, contents, message) {
  writeFileSync(path.join(directory, name), contents);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

function publishBranch(seed, branch, startPoint = "main") {
  git(seed, ["switch", "-c", branch, startPoint]);
  commitFile(seed, `${branch.replaceAll("/", "-")}.txt`, `${branch}\n`, `Create ${branch}`);
  git(seed, ["push", "-u", "origin", branch]);
  git(seed, ["switch", "main"]);
}

async function cloneRepository(fixture, name, initialize = false) {
  const directory = path.join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, directory]);
  configureIdentity(directory);
  const repo = await GitRepository.open(directory);
  if (initialize) {
    await initializeRepository(repo);
  }
  return { directory, repo };
}

function heads(directory, namespace = "refs/heads") {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", namespace]);
}

function branchTip(directory, branch) {
  return git(directory, ["rev-parse", `refs/heads/${branch}`]);
}

function branchExists(directory, branch) {
  try {
    branchTip(directory, branch);
    return true;
  } catch {
    return false;
  }
}

function assertParity(fixture, clone) {
  assert.equal(heads(clone.directory), heads(fixture.remote), "successful Save establishes ordinary-branch parity");
  assert.equal(git(clone.directory, ["status", "--porcelain=v1"]), "");
}

async function runMultiBranchPublication() {
  await withFixture("wipstream-save-multi-", async (fixture) => {
    publishBranch(fixture.seed, "branch-a");
    publishBranch(fixture.seed, "branch-b");
    const clone = await cloneRepository(fixture, "clone", true);
    git(clone.directory, ["switch", "branch-a"]);
    commitFile(clone.directory, "branch-a-advance.txt", "advance a\n", "Advance branch A");
    git(clone.directory, ["switch", "-c", "local-new", "main"]);
    commitFile(clone.directory, "local-new.txt", "new local branch\n", "Create local branch");
    git(clone.directory, ["switch", "branch-b"]);
    const beforeCheckpoint = branchTip(clone.directory, "branch-b");
    writeFileSync(path.join(clone.directory, "branch-b-checkpoint.txt"), "checkpoint b\n");
    let prompts = 0;

    const result = await commitAndSave(clone.repo, {
      requestCheckpointMessage: async (suggested) => {
        prompts += 1;
        assert.match(suggested, /^WIP checkpoint \d{4}-\d{2}-\d{2}T/);
        return "Checkpoint branch B";
      },
    });
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, true);
    assert.equal(result.handoff, "complete");
    assert.match(result.message, /safe to resume from the remote/i);
    assert.deepEqual(result.publishedBranches, ["branch-a", "branch-b", "local-new"]);
    assert.deepEqual(
      result.advisories.filter(({ branch }) => ["branch-a", "branch-b", "local-new"].includes(branch)),
      [
        { branch: "branch-a", parent: "main", source: "assumed-default", state: "current" },
        { branch: "branch-b", parent: "main", source: "assumed-default", state: "current" },
        { branch: "local-new", parent: "main", source: "assumed-default", state: "current" },
      ]
    );
    assert.equal(prompts, 1);
    assert.equal(git(clone.directory, ["config", "--get", "branch.branch-a.remote"]), "origin");
    assert.equal(git(clone.directory, ["config", "--get", "branch.branch-b.remote"]), "origin");
    assert.equal(git(clone.directory, ["config", "--get", "branch.local-new.remote"]), "origin");
    assertParity(fixture, clone);

    const receipt = await readOperationReceipt(clone.repo, result.operationId);
    assert.deepEqual(receipt.plan.checkpoint, {
      branch: "branch-b",
      before: beforeCheckpoint,
      after: branchTip(clone.directory, "branch-b"),
      message: "Checkpoint branch B",
    });
    assert.equal(
      git(clone.directory, ["rev-parse", recoveryRef(result.operationId, receipt.plan.localRefUpdates.length)]),
      beforeCheckpoint
    );

    const noOp = await commitAndSave(clone.repo, {
      requestCheckpointMessage: async () => {
        throw new Error("no-op Save must not prompt");
      },
    });
    assert.equal(noOp.checkpointCreated, false);
    assert.equal(noOp.published, true);
    assert.deepEqual(noOp.publishedBranches, []);
  });
}

async function runUnrelatedRemoteAdvance() {
  await withFixture("wipstream-save-unrelated-", async (fixture) => {
    publishBranch(fixture.seed, "local-work");
    publishBranch(fixture.seed, "remote-work");
    const clone = await cloneRepository(fixture, "clone", true);
    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/remote-work"]);
    commitFile(publisher.directory, "remote-work-advance.txt", "remote advance\n", "Advance remote work");
    git(publisher.directory, ["push", "origin", "remote-work"]);
    const remoteAdvance = branchTip(publisher.directory, "remote-work");

    git(clone.directory, ["switch", "local-work"]);
    writeFileSync(path.join(clone.directory, "local-checkpoint.txt"), "local checkpoint\n");
    const result = await commitAndSave(clone.repo);
    assert.equal(result.published, true);
    assert.deepEqual(result.publishedBranches, ["local-work"]);
    assert.deepEqual(result.fastForwarded, ["remote-work"]);
    assert.equal(branchTip(clone.directory, "remote-work"), remoteAdvance);
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "local-work");
    assertParity(fixture, clone);
  });
}

async function runOfflineCheckpoint() {
  await withFixture("wipstream-save-offline-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    writeFileSync(path.join(clone.directory, "offline.txt"), "safe locally\n");
    const unavailableRemote = path.join(fixture.root, "remote-unavailable.git");
    renameSync(fixture.remote, unavailableRemote);

    const result = await commitAndSave(clone.repo);
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, false);
    assert.equal(result.failure, "offline");
    assert.equal(result.handoff, "do-not-resume");
    assert.match(result.message, /do not resume/i);
    assert.match(git(clone.directory, ["log", "-1", "--format=%s"]), /^WIP checkpoint \d{4}-\d{2}-\d{2}T/);
    assert.equal(git(clone.directory, ["status", "--porcelain=v1"]), "");
    assert.notEqual(branchTip(clone.directory, "main"), branchTip(unavailableRemote, "main"));
  });
}

async function runDivergenceRetention() {
  await withFixture("wipstream-save-divergence-", async (fixture) => {
    publishBranch(fixture.seed, "topic");
    const clone = await cloneRepository(fixture, "clone", true);
    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/topic"]);
    commitFile(publisher.directory, "remote-topic.txt", "remote topic\n", "Advance topic remotely");
    git(publisher.directory, ["push", "origin", "topic"]);
    const remoteTip = branchTip(fixture.remote, "topic");

    git(clone.directory, ["switch", "topic"]);
    writeFileSync(path.join(clone.directory, "local-topic.txt"), "local topic\n");
    const result = await commitAndSave(clone.repo, {
      requestCheckpointMessage: async () => "Retained divergent checkpoint",
    });
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, false);
    assert.equal(result.failure, "unsafe-branches");
    assert.equal(result.reconcileBranch, "topic");
    assert.equal(result.handoff, "do-not-resume");
    assert.match(result.message, /do not resume/i);
    assert.equal(git(clone.directory, ["log", "-1", "--format=%s"]), "Retained divergent checkpoint");
    assert.equal(branchTip(fixture.remote, "topic"), remoteTip, "divergence publishes no local ref");
    assert.equal((await inspectIncompleteOperations(clone.repo)).length, 0);
  });
}

async function runAtomicRemoteRace() {
  await withFixture("wipstream-save-race-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    const publisher = await cloneRepository(fixture, "publisher");
    git(clone.directory, ["switch", "-c", "local-only", "main"]);
    commitFile(clone.directory, "local-only.txt", "must publish atomically\n", "Create local-only");
    git(clone.directory, ["switch", "main"]);
    writeFileSync(path.join(clone.directory, "local-main.txt"), "local main\n");
    let raced = false;

    const result = await commitAndSave(clone.repo, {
      beforeRemotePush: async () => {
        raced = true;
        commitFile(publisher.directory, "remote-main.txt", "remote main\n", "Win remote race");
        git(publisher.directory, ["push", "origin", "main"]);
      },
    });
    assert.equal(raced, true);
    assert.equal(result.published, false);
    assert.equal(result.failure, "remote-changed");
    assert.equal(result.handoff, "do-not-resume");
    assert.match(result.message, /do not resume/i);
    assert.equal(branchExists(fixture.remote, "local-only"), false, "atomic rejection publishes no companion branch");
    assert.equal(branchTip(fixture.remote, "main"), branchTip(publisher.directory, "main"));
    assert.match(git(clone.directory, ["log", "-1", "--format=%s"]), /^WIP checkpoint \d{4}-\d{2}-\d{2}T/);
    const incomplete = await inspectIncompleteOperations(clone.repo);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].plan.operationId, result.operationId);
    assert.equal(incomplete[0].phase, "before-remote-push");
  });
}

async function runDefaultBranchAndDocumentSave() {
  await withFixture("wipstream-save-main-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    let documentsSaved = false;
    let prompted = false;
    const result = await commitAndSave(clone.repo, {
      saveDocuments: async () => {
        documentsSaved = true;
        writeFileSync(path.join(clone.directory, "saved-document.txt"), "saved before staging\n");
      },
      requestCheckpointMessage: async () => {
        prompted = true;
        return "Work directly on main";
      },
    });
    assert.equal(documentsSaved, true);
    assert.equal(prompted, true);
    assert.equal(result.checkpointCreated, true);
    assert.equal(result.published, true);
    assert.deepEqual(result.publishedBranches, ["main"]);
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "main");
    assert.equal(git(clone.directory, ["log", "-1", "--format=%s"]), "Work directly on main");
    assert.equal(git(fixture.remote, ["show", "main:saved-document.txt"]), "saved before staging");
    assertParity(fixture, clone);
  });
}

async function runRejectedCommitHook() {
  await withFixture("wipstream-save-hook-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    const before = branchTip(clone.directory, "main");
    const hook = path.join(clone.directory, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho blocked >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(clone.directory, "blocked.txt"), "stays staged\n");

    await assert.rejects(
      () => commitAndSave(clone.repo, { requestCheckpointMessage: async () => "Rejected checkpoint" }),
      (error) => error instanceof GitError && /blocked/.test(error.message)
    );
    assert.equal(branchTip(clone.directory, "main"), before);
    assert.equal(git(clone.directory, ["diff", "--cached", "--name-only"]), "blocked.txt");
    assert.equal(branchTip(fixture.remote, "main"), before);
    assert.equal((await inspectIncompleteOperations(clone.repo)).length, 0);
  });
}

async function runCancelledFetch() {
  await withFixture("wipstream-save-cancelled-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    const controller = new AbortController();
    controller.abort();
    const result = await commitAndSave(clone.repo.withNetworkCancellation(controller.signal));
    assert.equal(result.published, false);
    assert.equal(result.failure, "cancelled");
    assert.equal(result.handoff, "do-not-resume");
    assert.match(result.message, /cancelled/i);
    assert.equal((await inspectIncompleteOperations(clone.repo)).length, 0);
  });
}

async function runCancellationAfterReceipt() {
  await withFixture("wipstream-save-cancelled-after-receipt-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone", true);
    writeFileSync(path.join(clone.directory, "cancelled-after-push.txt"), "checkpoint\n");
    const controller = new AbortController();
    const result = await commitAndSave(clone.repo.withNetworkCancellation(controller.signal), {
      requestCheckpointMessage: async () => "Checkpoint before cancellation",
      afterRemotePush: async () => controller.abort(),
    });
    assert.equal(result.published, false);
    assert.equal(result.failure, "incomplete");
    assert.equal(result.handoff, "do-not-resume");
    assert.ok(result.operationId);
    assert.match(result.message, /inspect operation/i);
    const incomplete = await inspectIncompleteOperations(clone.repo);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].plan.operationId, result.operationId);
    assert.equal(incomplete[0].phase, "before-remote-fetch");
  });
}

Promise.resolve()
  .then(runMultiBranchPublication)
  .then(runUnrelatedRemoteAdvance)
  .then(runOfflineCheckpoint)
  .then(runDivergenceRetention)
  .then(runAtomicRemoteRace)
  .then(runDefaultBranchAndDocumentSave)
  .then(runRejectedCommitHook)
  .then(runCancelledFetch)
  .then(runCancellationAfterReceipt)
  .then(() => console.log("WipStream generalized Commit and Save tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
