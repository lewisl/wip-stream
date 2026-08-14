const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { initialize, resume, saveUp, toFeature, toMain, WorkflowError } = require("../out/workflow");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Test"]);
  git(directory, ["config", "user.email", "wipstream-test@example.invalid"]);
}

async function expectWorkflowError(action, code) {
  try {
    await action();
    assert.fail(`Expected WipStream error ${code}`);
  } catch (error) {
    assert.ok(error instanceof WorkflowError, `Expected WorkflowError, got ${error}`);
    assert.equal(error.code, code);
  }
}

async function runLifecycle() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "wipstream-test-"));
  const remote = path.join(fixture, "remote.git");
  const seed = path.join(fixture, "seed");
  const firstClone = path.join(fixture, "first");
  const secondClone = path.join(fixture, "second");

  try {
    git(fixture, ["init", "--bare", remote]);
    git(fixture, ["init", seed]);
    configureIdentity(seed);
    writeFileSync(path.join(seed, "README.md"), "seed\n");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "Initial commit"]);
    git(seed, ["branch", "-M", "main"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    git(fixture, ["clone", remote, firstClone]);
    configureIdentity(firstClone);
    const first = await GitRepository.open(firstClone);

    assert.equal(await initialize(first), "created");
    assert.equal(await first.currentBranch(), "wip/feature", "Initialize starts the first editing session");
    assert.equal(await initialize(first), "current", "initialization is idempotent");
    assert.equal(await first.currentBranch(), "wip/feature");

    writeFileSync(path.join(firstClone, "README.md"), "first checkpoint\n");
    writeFileSync(path.join(firstClone, "untracked.txt"), "included in WIP\n");
    let cancelledPrompted = false;
    await assert.rejects(
      () => saveUp(first, async () => {
        cancelledPrompted = true;
        throw new WorkflowError("CANCELLED", "WipStream command cancelled.");
      }),
      (error) => error instanceof WorkflowError && error.code === "CANCELLED"
    );
    assert.equal(cancelledPrompted, true, "Save Up requests a message when it will create a checkpoint");
    assert.equal(await first.hasStagedChanges(), false, "Cancelling before staging leaves the index unchanged");
    assert.match(await first.statusPorcelain(), /README\.md|untracked\.txt/, "Cancelling leaves work uncommitted");

    const customMessage = "First computer checkpoint";
    const firstSave = await saveUp(first, async (defaultMessage) => {
      assert.match(defaultMessage, /^WIP checkpoint \d{4}-\d{2}-\d{2}T/);
      return customMessage;
    });
    assert.deepEqual(firstSave, { checkpointCreated: true, published: true });
    assert.equal(git(firstClone, ["log", "-1", "--format=%s", "wip/feature"]), customMessage);
    let noOpPrompted = false;
    assert.deepEqual(
      await saveUp(first, async () => {
        noOpPrompted = true;
        return "This message should not be used";
      }),
      { checkpointCreated: false, published: true },
      "Save Up is idempotent"
    );
    assert.equal(noOpPrompted, false, "Save Up does not request a message when there is no checkpoint");

    const submoduleSource = path.join(fixture, "submodule-source");
    git(fixture, ["init", submoduleSource]);
    configureIdentity(submoduleSource);
    writeFileSync(path.join(submoduleSource, "file.txt"), "initial\n");
    git(submoduleSource, ["add", "file.txt"]);
    git(submoduleSource, ["commit", "-m", "Initial submodule commit"]);
    git(firstClone, ["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "module"]);
    const submoduleCheckpoint = "Add submodule pointer";
    assert.deepEqual(
      await saveUp(first, async () => submoduleCheckpoint),
      { checkpointCreated: true, published: true }
    );
    const beforeDirtySubmodule = await first.hash("wip/feature");
    writeFileSync(path.join(firstClone, "module", "file.txt"), "uncommitted submodule work\n");
    let dirtySubmodulePrompted = false;
    await expectWorkflowError(
      () => saveUp(first, async () => {
        dirtySubmodulePrompted = true;
        return "This message should not be used";
      }),
      "DIRTY_SUBMODULES"
    );
    assert.equal(dirtySubmodulePrompted, false, "Save Up rejects dirty submodules before prompting");
    assert.equal(await first.hash("wip/feature"), beforeDirtySubmodule, "dirty submodules do not create a parent checkpoint");
    git(path.join(firstClone, "module"), ["restore", "file.txt"]);

    const wipHash = await first.hash("wip/feature");
    assert.equal(await toFeature(first), true);
    assert.equal(await first.hash("feature"), wipHash, "To Feature preserves the WIP commit exactly");
    assert.equal(git(firstClone, ["log", "-1", "--format=%s", "feature"]), submoduleCheckpoint);

    git(fixture, ["clone", remote, secondClone]);
    configureIdentity(secondClone);
    const second = await GitRepository.open(secondClone);
    assert.equal(await initialize(second), "attached");
    assert.equal(await second.currentBranch(), "wip/feature", "Initialize starts the attached editing session");
    assert.equal(readFileSync(path.join(secondClone, "untracked.txt"), "utf8"), "included in WIP\n");

    writeFileSync(path.join(secondClone, "stale.txt"), "stale work\n");
    await expectWorkflowError(() => resume(second), "DIRTY_WORKTREE");
    git(secondClone, ["restore", "--worktree", "--staged", "."]);
    git(secondClone, ["clean", "-fd"]);

    const hook = path.join(secondClone, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho blocked >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(secondClone, "hook-check.txt"), "must remain local\n");
    await assert.rejects(() => saveUp(second), /blocked/);
    assert.match(await second.statusPorcelain(), /hook-check\.txt/, "failed hooks leave work intact");
    rmSync(hook);

    const secondSave = await saveUp(second);
    assert.deepEqual(secondSave, { checkpointCreated: true, published: true });
    assert.equal(await initialize(first), "attached", "Initialize safely updates a stale checked-out WIP branch");
    assert.equal(await first.currentBranch(), "wip/feature", "Initialize preserves the previously checked-out branch");
    assert.equal(await toFeature(second), true);
    assert.equal(await toMain(second), "finished");
    assert.equal(await second.currentBranch(), "main");
    assert.equal(await second.refExists(second.remoteRef("origin", "feature")), false);
    assert.equal(await second.refExists(second.remoteRef("origin", "wip/feature")), false);
    assert.equal(await toMain(second), "already-finished", "To Main is retry-safe after cleanup");
    assert.equal(await resume(first), "completed", "Resume updates a stale clone after another machine completed the feature");
    assert.equal(await first.currentBranch(), "main");
    assert.equal(await first.hash("main"), await second.hash("main"));
    assert.equal(await first.branchExists("feature"), false);
    assert.equal(await first.branchExists("wip/feature"), false);
    assert.equal(await initialize(first), "created", "A stale completed clone can start the next stream safely");
    assert.equal(await first.currentBranch(), "wip/feature");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function runWipRewriteLifecycle() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "wipstream-rewrite-test-"));
  const remote = path.join(fixture, "remote.git");
  const seed = path.join(fixture, "seed");
  const firstClone = path.join(fixture, "first");
  const secondClone = path.join(fixture, "second");

  try {
    git(fixture, ["init", "--bare", remote]);
    git(fixture, ["init", seed]);
    configureIdentity(seed);
    writeFileSync(path.join(seed, "README.md"), "seed\n");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "Initial commit"]);
    git(seed, ["branch", "-M", "main"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    git(fixture, ["clone", remote, firstClone]);
    configureIdentity(firstClone);
    const first = await GitRepository.open(firstClone);
    await initialize(first);

    writeFileSync(path.join(firstClone, "first.txt"), "first checkpoint\n");
    await saveUp(first);
    writeFileSync(path.join(firstClone, "second.txt"), "second checkpoint\n");
    await saveUp(first);

    git(firstClone, ["reset", "--soft", "HEAD~2"]);
    git(firstClone, ["commit", "-m", "Condensed WIP checkpoint"]);
    let rewritePrompted = false;
    const rewritten = await saveUp(first, undefined, async ({ unverifiedBase }) => {
      rewritePrompted = true;
      assert.equal(unverifiedBase, false, "a current WipStream handoff records a rewrite lease");
      return true;
    });
    assert.equal(rewritePrompted, true, "rewriting remote WIP checkpoints requires confirmation");
    assert.deepEqual(rewritten, { checkpointCreated: false, published: true, wipHistoryRewritten: true });
    assert.equal(
      await first.hash("wip/feature"),
      await first.hash(first.remoteRef("origin", "wip/feature")),
      "the confirmed condensed WIP history is published"
    );
    assert.equal(await toFeature(first), true, "To Feature accepts the condensed WIP history");

    writeFileSync(path.join(firstClone, "follow-up.txt"), "first machine follow-up\n");
    await saveUp(first);

    git(fixture, ["clone", remote, secondClone]);
    configureIdentity(secondClone);
    const second = await GitRepository.open(secondClone);
    await initialize(second);
    writeFileSync(path.join(secondClone, "second-machine.txt"), "second machine handoff\n");
    await saveUp(second);

    git(firstClone, ["reset", "--soft", "HEAD~1"]);
    git(firstClone, ["commit", "-m", "Rewritten follow-up"]);
    let staleRewritePrompted = false;
    await expectWorkflowError(
      () => saveUp(first, undefined, async () => {
        staleRewritePrompted = true;
        return true;
      }),
      "REMOTE_WIP_CHANGED"
    );
    assert.equal(staleRewritePrompted, false, "WipStream never offers to replace a newer remote handoff");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(runLifecycle)
  .then(runWipRewriteLifecycle)
  .then(() => console.log("WipStream workflow integration tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
