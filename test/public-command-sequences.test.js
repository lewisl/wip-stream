const assert = require("assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const path = require("path");
const { withFixture, git, heads } = require("./setup-fixture");
const { GitRepository } = require("../out/git");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { getFromRemote, commitAndSave } = require("../out/generalized-workflow");
const { startBranch, finishBranch } = require("../out/lifecycle-workflow");
const { undoLastAction } = require("../out/undo-workflow");
const { readRepositoryConfiguration } = require("../out/repository-model");
const { readOperationReceipt, inspectIncompleteOperations } = require("../out/operations");

async function everydayCommands(kind) {
  await withFixture(async ({ seed, remote, clone }) => {
    // The seed was created by git init + remote add, rather than git clone.
    const repo = await GitRepository.open(seed);
    assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), undefined);
    const contents = Buffer.from("this machine's work   \t\n");
    if (kind === "local-work") writeFileSync(path.join(seed, "local.txt"), contents);
    const choice = kind === "remote"
      ? { kind, backup: { kind: "discard", confirmed: true } }
      : { kind };
    const setup = await executeRepositorySetup(repo, await inspectRepositorySetup(repo), choice);
    assert.equal(setup.kind, "completed", setup.message);
    assert.equal((await readOperationReceipt(repo, setup.operationId)).status, "completed");
    assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), "refs/remotes/origin/main");
    assert.deepEqual(await readRepositoryConfiguration(repo), { kind: "initialized", remote: "origin" });
    assert.deepEqual(await repo.getConfigValues("branch.main.remote"), ["origin"]);
    assert.deepEqual(await repo.getConfigValues("branch.main.merge"), ["refs/heads/main"]);
    if (kind === "local-work") assert.deepEqual(readFileSync(path.join(seed, "local.txt")), contents);

    // Do not undo or reinitialize between public setup and these commands.
    await getFromRemote(repo);
    const savedBytes = Buffer.from("saved after public setup   \n");
    writeFileSync(path.join(seed, "saved.txt"), savedBytes);
    const saved = await commitAndSave(repo);
    assert.equal(saved.published, true, saved.message);
    assert.equal((await readOperationReceipt(repo, saved.operationId)).status, "completed");
    assert.equal(git(remote, ["rev-parse", "main"]), await repo.hash("HEAD"));

    if (kind === "local-work") {
      await startBranch(repo, "feature");
      writeFileSync(path.join(seed, "feature.txt"), "feature work\n");
      const finished = await finishBranch(repo, { chooseDisposition: async () => "delete" });
      assert.equal((await readOperationReceipt(repo, finished.operationId)).status, "completed");
      assert.equal(await repo.currentBranch(), "main");
      assert.equal(await repo.refExists("refs/heads/feature"), false);
      assert.deepEqual(await repo.branchConfigurationKeys("feature"), []);
    }
    const observer = await clone("observer");
    assert.equal(heads(observer.directory), heads(seed));
    assert.deepEqual(readFileSync(path.join(observer.directory, "saved.txt")), savedBytes);
    assert.equal(existsSync(path.join(observer.directory, "feature.txt")), kind === "local-work");
    assert.deepEqual(await inspectIncompleteOperations(repo), []);
    assert.equal(await repo.statusPorcelain(), "");
  });
}

async function undoPublicSetupCheckpoint() {
  await withFixture(async ({ seed, remote }) => {
    const repo = await GitRepository.open(seed);
    const before = await repo.hash("HEAD");
    const remoteBefore = heads(remote);
    const configBefore = git(seed, ["config", "--local", "--list"]);
    const bytes = Buffer.from("uncommitted setup work   \t");
    writeFileSync(path.join(seed, "draft.txt"), bytes);
    assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), undefined);
    assert.match(await repo.statusPorcelain(), /\?\? draft.txt/);
    const setup = await executeRepositorySetup(repo, await inspectRepositorySetup(repo), { kind: "local-work" });
    assert.equal(setup.kind, "completed", setup.message);
    assert.equal(setup.checkpointCreated, true);
    assert.notEqual(await repo.hash("HEAD"), before);
    await undoLastAction(repo);
    assert.equal(await repo.hash("HEAD"), before);
    assert.equal(heads(remote), remoteBefore);
    assert.equal(git(seed, ["config", "--local", "--list"]), configBefore);
    assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), undefined);
    assert.deepEqual(await readRepositoryConfiguration(repo), { kind: "uninitialized" });
    assert.deepEqual(readFileSync(path.join(seed, "draft.txt")), bytes);
    assert.match(await repo.statusPorcelain(), /\?\? draft.txt/);
    assert.equal((await readOperationReceipt(repo, setup.operationId)).status, "undone");
    assert.deepEqual(await inspectIncompleteOperations(repo), []);
  });
}

async function run() {
  await everydayCommands("local-work");
  await everydayCommands("remote");
  await undoPublicSetupCheckpoint();
  console.log("WipStream public setup command sequences passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
