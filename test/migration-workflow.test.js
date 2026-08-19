const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { initializeRepository } = require("../out/generalized-workflow");
const {
  MigrationWorkflowError,
  migrateVersion1Repository,
  previewVersion1Migration,
} = require("../out/migration-workflow");
const { completeOperation, inspectIncompleteOperations, listOperationReceipts } = require("../out/operations");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { inspectUndoEligibility, undoLastAction } = require("../out/undo-workflow");
const { initialize, saveUp, toFeature, toMain } = require("../out/workflow");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function identity(directory) {
  git(directory, ["config", "user.name", "Migration Test"]);
  git(directory, ["config", "user.email", "migration@example.invalid"]);
}

function fixture(prefix, main = "main") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", seed]);
  identity(seed);
  writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "-m", "base"]);
  git(seed, ["branch", "-M", main]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", main]);
  git(remote, ["symbolic-ref", "HEAD", `refs/heads/${main}`]);
  return { root, remote, seed, main };
}

async function usingFixture(prefix, action, main = "main") {
  const value = fixture(prefix, main);
  try {
    await action(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

async function clone(fixtureValue, name, remote = "origin") {
  const directory = path.join(fixtureValue.root, name);
  git(fixtureValue.root, ["clone", fixtureValue.remote, directory]);
  identity(directory);
  if (remote !== "origin") git(directory, ["remote", "rename", "origin", remote]);
  return { directory, repo: await GitRepository.open(directory) };
}

function commit(directory, file, contents, message) {
  writeFileSync(path.join(directory, file), contents);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

function tip(directory, branch) {
  return git(directory, ["rev-parse", `refs/heads/${branch}`]);
}

function exists(directory, branch) {
  try {
    tip(directory, branch);
    return true;
  } catch {
    return false;
  }
}

function heads(directory) {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
}

function config(directory) {
  return git(directory, ["config", "--local", "--list"]);
}

async function expectMigrationError(action, code) {
  await assert.rejects(action, (error) => error instanceof MigrationWorkflowError && error.code === code);
}

async function activeDefaultPreviewMigrationAndUndo() {
  await usingFixture("migration-active-", async (f) => {
    git(f.seed, ["switch", "-c", "reference"]);
    commit(f.seed, "reference.txt", "reference\n", "reference");
    git(f.seed, ["push", "-u", "origin", "reference"]);
    git(f.seed, ["switch", "main"]);
    const c = await clone(f, "clone");
    await initialize(c.repo);
    commit(c.directory, "checkpoint.txt", "checkpoint\n", "checkpoint");
    await saveUp(c.repo);
    const featureBefore = tip(c.directory, "feature");
    const wipBefore = tip(c.directory, "wip/feature");
    const localBefore = heads(c.directory);
    const remoteBefore = heads(f.remote);
    const configBefore = config(c.directory);
    const checkoutBefore = git(c.directory, ["branch", "--show-current"]);

    const preview = await previewVersion1Migration(c.repo);
    assert.equal(preview.kind, "active");
    assert.equal(preview.preservedCheckpointTip, wipBefore);
    assert.deepEqual(preview.remoteRefUpdates.map(({ ref, proposed }) => [ref, proposed]), [
      ["refs/heads/feature", wipBefore],
      ["refs/heads/wip/feature", null],
    ]);
    assert.equal(heads(c.directory), localBefore, "preview does not change ordinary local refs");
    assert.equal(heads(f.remote), remoteBefore, "preview does not change remote refs");
    assert.equal(config(c.directory), configBefore, "preview does not change local configuration");
    assert.equal(git(c.directory, ["branch", "--show-current"]), checkoutBefore);

    let confirmedPreview;
    const result = await initializeRepository(c.repo, undefined, {
      confirmMigrationPreview: async (value) => {
        confirmedPreview = value;
        return true;
      },
    });
    assert.equal(confirmedPreview.kind, "active");
    assert.equal(result.checkout, "main");
    assert.equal(tip(c.directory, "feature"), wipBefore);
    assert.equal(tip(f.remote, "feature"), wipBefore);
    assert.equal(exists(c.directory, "wip/feature"), false);
    assert.equal(exists(f.remote, "wip/feature"), false);
    assert.equal(exists(c.directory, "reference"), true, "normal remote branches are reconciled during migration");
    assert.equal(git(c.directory, ["config", "--get", "branch.feature.wipstreamParent"]), "main");
    assert.deepEqual(await readRepositoryConfiguration(c.repo), { kind: "version2", version: "2", remote: "origin" });
    assert.equal((await inspectUndoEligibility(c.repo)).eligible, true);

    await undoLastAction(c.repo);
    assert.equal(tip(c.directory, "feature"), featureBefore);
    assert.equal(tip(c.directory, "wip/feature"), wipBefore);
    assert.equal(tip(f.remote, "feature"), featureBefore);
    assert.equal(tip(f.remote, "wip/feature"), wipBefore);
    assert.equal(git(c.directory, ["branch", "--show-current"]), "wip/feature");
    const restored = await readRepositoryConfiguration(c.repo);
    assert.equal(restored.kind, "version1");
    assert.equal(restored.lastKnownRemoteWip, wipBefore);
  });
}

async function activeCustomNames() {
  await usingFixture("migration-custom-", async (f) => {
    const c = await clone(f, "clone", "upstream");
    await initialize(c.repo, {
      remote: "upstream",
      mainBranch: "trunk",
      featureBranch: "change/accepted",
      wipBranch: "checkpoint/change",
    });
    commit(c.directory, "custom.txt", "custom\n", "custom checkpoint");
    await saveUp(c.repo);
    const checkpoint = tip(c.directory, "checkpoint/change");
    const result = await migrateVersion1Repository(c.repo, { confirmPreview: async () => true });
    assert.equal(result.migration, "active");
    assert.equal(result.checkout, "trunk");
    assert.equal(tip(c.directory, "change/accepted"), checkpoint);
    assert.equal(tip(f.remote, "change/accepted"), checkpoint);
    assert.equal(exists(c.directory, "checkpoint/change"), false);
    assert.equal(exists(f.remote, "checkpoint/change"), false);
    assert.equal(git(c.directory, ["config", "--get", "branch.change/accepted.wipstreamParent"]), "trunk");
    assert.deepEqual(await readRepositoryConfiguration(c.repo), { kind: "version2", version: "2", remote: "upstream" });
  }, "trunk");
}

async function completedAndStaleCloneMigration() {
  await usingFixture("migration-completed-", async (f) => {
    const first = await clone(f, "first");
    await initialize(first.repo);
    const stale = await clone(f, "stale");
    await initialize(stale.repo);
    commit(first.directory, "finished.txt", "finished\n", "finished checkpoint");
    await saveUp(first.repo);
    await toFeature(first.repo);
    await toMain(first.repo);
    const completedMain = tip(f.remote, "main");

    const firstResult = await initializeRepository(first.repo);
    assert.equal(firstResult.migration, "completed");
    assert.equal(tip(first.directory, "main"), completedMain);
    assert.equal(exists(first.directory, "feature"), false);

    const staleResult = await migrateVersion1Repository(stale.repo);
    assert.equal(staleResult.migration, "completed");
    assert.equal(tip(stale.directory, "main"), completedMain);
    assert.equal(exists(stale.directory, "feature"), false);
    assert.equal(exists(stale.directory, "wip/feature"), false);
    assert.deepEqual(await readRepositoryConfiguration(stale.repo), { kind: "version2", version: "2", remote: "origin" });
  });
}

async function refusalStatesAreNonMutating() {
  await usingFixture("migration-partial-", async (f) => {
    const c = await clone(f, "clone");
    await initialize(c.repo);
    git(c.directory, ["push", "origin", ":feature"]);
    const localBefore = heads(c.directory);
    const remoteBefore = heads(f.remote);
    const configBefore = config(c.directory);
    await expectMigrationError(() => migrateVersion1Repository(c.repo), "MIGRATION_PARTIAL_REMOTE_STREAM");
    assert.equal(heads(c.directory), localBefore);
    assert.equal(heads(f.remote), remoteBefore);
    assert.equal(config(c.directory), configBefore);
    assert.deepEqual(await listOperationReceipts(c.repo), []);
  });

  await usingFixture("migration-diverged-", async (f) => {
    const c = await clone(f, "clone");
    await initialize(c.repo);
    commit(c.directory, "local.txt", "local\n", "local only");
    const publisher = await clone(f, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/wip/feature"]);
    commit(publisher.directory, "remote.txt", "remote\n", "remote only");
    git(publisher.directory, ["push", "origin", "wip/feature"]);
    const localBefore = heads(c.directory);
    const remoteBefore = heads(f.remote);
    const configBefore = config(c.directory);
    await expectMigrationError(() => migrateVersion1Repository(c.repo), "MIGRATION_NOT_SYNCHRONIZED");
    assert.equal(heads(c.directory), localBefore);
    assert.equal(heads(f.remote), remoteBefore);
    assert.equal(config(c.directory), configBefore);
    assert.deepEqual(await listOperationReceipts(c.repo), []);
  });

  await usingFixture("migration-proof-", async (f) => {
    const c = await clone(f, "clone");
    await initialize(c.repo);
    git(c.directory, ["config", "--unset-all", "wipstream.lastKnownRemoteWip"]);
    await expectMigrationError(() => migrateVersion1Repository(c.repo), "MIGRATION_WIP_PROOF_REQUIRED");
    assert.deepEqual(await listOperationReceipts(c.repo), []);
  });
}

async function cancellationAndRemoteSuccessRetry() {
  await usingFixture("migration-retry-", async (f) => {
    const c = await clone(f, "clone");
    await initialize(c.repo);
    commit(c.directory, "retry.txt", "retry\n", "retry checkpoint");
    await saveUp(c.repo);
    const localBefore = heads(c.directory);
    const remoteBefore = heads(f.remote);
    const configBefore = config(c.directory);
    await expectMigrationError(
      () => migrateVersion1Repository(c.repo, { confirmPreview: async () => false }),
      "MIGRATION_CANCELLED"
    );
    assert.equal(heads(c.directory), localBefore);
    assert.equal(heads(f.remote), remoteBefore);
    assert.equal(config(c.directory), configBefore);
    assert.deepEqual(await listOperationReceipts(c.repo), []);

    await assert.rejects(
      () => migrateVersion1Repository(c.repo, {
        afterRemotePush: async () => {
          throw new Error("injected post-push interruption");
        },
      }),
      /injected post-push interruption/
    );
    assert.equal(heads(c.directory), localBefore, "remote success does not partially update local ordinary refs");
    assert.equal(exists(f.remote, "wip/feature"), false);
    const incomplete = await inspectIncompleteOperations(c.repo);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].phase, "after-remote-push");
    await completeOperation(c.repo, incomplete[0].plan.operationId);

    const retry = await migrateVersion1Repository(c.repo);
    assert.equal(retry.remoteAlreadyMigrated, true);
    assert.equal(exists(c.directory, "wip/feature"), false);
    assert.equal(tip(c.directory, "feature"), tip(f.remote, "feature"));
    assert.deepEqual(await readRepositoryConfiguration(c.repo), { kind: "version2", version: "2", remote: "origin" });
  });
}

Promise.resolve()
  .then(activeDefaultPreviewMigrationAndUndo)
  .then(activeCustomNames)
  .then(completedAndStaleCloneMigration)
  .then(refusalStatesAreNonMutating)
  .then(cancellationAndRemoteSuccessRetry)
  .then(() => console.log("WipStream version 1 migration tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
