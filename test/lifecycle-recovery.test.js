const assert = require("assert/strict");
const { existsSync, writeFileSync } = require("fs");
const path = require("path");
const { withFixture, git, commitFile } = require("./setup-fixture");
const { repositoryState } = require("./fixture-state");
const { executeRepositorySetup, inspectRepositorySetup } = require("../out/setup-workflow");
const { commitAndSave } = require("../out/generalized-workflow");
const { startBranch, finishBranch, condenseBranch } = require("../out/lifecycle-workflow");
const { inspectIncompleteOperations, readOperationReceipt, recoveryRef } = require("../out/operations");
const { commandLockPath } = require("../out/repository-safety");
const { recoverIncompleteOperation } = require("../out/recovery-workflow");

const interruptions = [
  { method: "pushRefsAtomic", after: false, phase: "before-remote-push", published: false, moved: false, checkout: "feature" },
  { method: "pushRefsAtomic", after: true, phase: "before-remote-push", published: true, moved: false, checkout: "feature" },
  { method: "fetchAllBranches", after: false, phase: "before-remote-fetch", published: true, moved: false, checkout: "feature" },
  { method: "fetchAllBranches", after: true, phase: "before-remote-fetch", published: true, moved: false, checkout: "feature" },
  { method: "detach", after: false, phase: "before-checkout", published: true, moved: false, checkout: "feature" },
  { method: "detach", after: true, phase: "before-checkout", published: true, moved: false, checkout: undefined },
  { method: "updateRefs", after: false, phase: "before-local-refs", published: true, moved: false, checkout: undefined },
  { method: "updateRefs", after: true, phase: "before-local-refs", published: true, moved: true, checkout: undefined },
  { method: "switch", after: false, phase: "before-checkout", published: true, moved: true, checkout: undefined },
  { method: "switch", after: true, phase: "before-checkout", published: true, moved: true, checkout: "destination" },
];

async function preparedFeature(clone) {
  const value = await clone("worker");
  const setup = await executeRepositorySetup(value.repo, await inspectRepositorySetup(value.repo), { kind: "local-work" });
  assert.equal(setup.kind, "completed", setup.message);
  await startBranch(value.repo, "feature");
  commitFile(value.directory, "one.txt", "one\n", "One");
  commitFile(value.directory, "two.txt", "two\n", "Two");
  assert.equal((await commitAndSave(value.repo)).published, true);
  assert.equal(git(value.directory, ["rev-list", "--count", "main..feature"]), "2");
  return value;
}

async function interruptedLifecycle(command, disposition, interruption) {
  await withFixture(async ({ clone, remote }) => {
    const { repo, directory } = await preparedFeature(clone);
    const parentBefore = await repo.hash("main");
    const featureBefore = await repo.hash("feature");
    const treeBefore = git(directory, ["rev-parse", "feature^{tree}"]);
    const configKey = "branch.feature.description";
    await repo.replaceConfigValues(configKey, ["retain this configuration"]);
    const title = command === "finish" ? "Finish Branch" : "Condense Branch";
    const original = repo[interruption.method].bind(repo);
    let injected = false;
    repo[interruption.method] = async (...args) => {
      const receipt = (await inspectIncompleteOperations(repo)).find(item => item.plan.command === title);
      // Finish's preceding Save is allowed to complete normally.
      if (receipt && !injected) {
        injected = true;
        if (interruption.after) await original(...args);
        throw new Error("injected lifecycle interruption");
      }
      return original(...args);
    };
    try {
      await assert.rejects(() => command === "finish"
        ? finishBranch(repo, { chooseDisposition: async () => disposition })
        : condenseBranch(repo, { confirmPreview: async () => true, requestMessage: async () => "Condensed feature" }),
      /injected lifecycle interruption/);
    } finally {
      repo[interruption.method] = original;
    }
    assert.equal(injected, true, `${title}: interruption must reach ${interruption.method}`);
    const incomplete = await inspectIncompleteOperations(repo);
    assert.equal(incomplete.length, 1);
    const receipt = incomplete[0];
    assert.equal(receipt.plan.command, title);
    assert.equal(receipt.status, "in-progress");
    assert.equal(receipt.phase, interruption.phase);
    const destination = command === "finish" ? "main" : "feature";
    const proposed = receipt.plan.remoteRefUpdates[0].proposed;
    const expectedCheckout = interruption.checkout === "destination" ? destination : interruption.checkout;
    assert.equal(await repo.currentBranch(), expectedCheckout);
    assert.equal(await repo.hash("HEAD"), interruption.moved && expectedCheckout === destination ? proposed : featureBefore);
    assert.equal(git(remote, ["rev-parse", destination]), interruption.published ? proposed : (command === "finish" ? parentBefore : featureBefore));
    assert.equal(await repo.hash(destination), interruption.moved ? proposed : (command === "finish" ? parentBefore : featureBefore));
    if (command === "finish") {
      assert.equal(await repo.refExists("refs/heads/feature"), !(disposition === "delete" && interruption.moved));
      const remoteFeature = git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/feature"]) === "refs/heads/feature";
      assert.equal(remoteFeature, !(disposition === "delete" && interruption.published));
    } else {
      assert.equal(git(directory, ["rev-parse", `${proposed}^{tree}`]), treeBefore);
      assert.notEqual(proposed, featureBefore);
    }
    for (const [index, update] of receipt.plan.localRefUpdates.entries()) {
      if (update.expectedOld) {
        assert.equal(await repo.objectId(recoveryRef(receipt.plan.operationId, index)), interruption.moved ? update.expectedOld : undefined,
          "this operation owns the recovery snapshot for its prior tip");
      }
    }
    assert.deepEqual(await repo.getConfigValues(configKey), interruption.configurationRemoved ? [] : ["retain this configuration"]);
    for (const change of receipt.plan.configurationChanges) {
      const changed = interruption.configurationComplete || (interruption.configurationRemoved && change.key === configKey);
      assert.deepEqual(await repo.getConfigValues(change.key), changed ? change.after : change.before, change.key);
    }
    assert.equal(existsSync(await commandLockPath(repo)), false);

    // Later work must survive explicit recovery even in a detached checkout.
    writeFileSync(path.join(directory, "later.txt"), "later staged work   \n");
    git(directory, ["add", "later.txt"]);
    writeFileSync(path.join(directory, "one.txt"), "later unstaged work\n");
    writeFileSync(path.join(directory, "untracked.txt"), "later untracked work\n");
    const beforeRecovery = await repositoryState(repo, remote);
    const recovered = await recoverIncompleteOperation(repo, receipt.plan.operationId);
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recovery.resolution, "kept-current-state");
    assert.deepEqual(await repositoryState(repo, remote), beforeRecovery);
    assert.equal((await readOperationReceipt(repo, receipt.plan.operationId)).status, "recovered");
    assert.deepEqual(await inspectIncompleteOperations(repo), []);
    assert.equal(existsSync(await commandLockPath(repo)), false);
  });
}

async function parentAdvancesDuringFinish() {
  await withFixture(async ({ clone, remote }) => {
    const { repo, directory } = await preparedFeature(clone);
    const publisher = await clone("publisher");
    const parentBefore = await repo.hash("main");
    const featureBefore = await repo.hash("feature");
    const push = repo.pushRefsAtomic.bind(repo);
    let concurrentTip;
    repo.pushRefsAtomic = async (...args) => {
      const receipt = (await inspectIncompleteOperations(repo)).find(item => item.plan.command === "Finish Branch");
      if (receipt && !concurrentTip) {
        assert.equal(receipt.plan.remoteRefUpdates[0].expected, parentBefore);
        commitFile(publisher.directory, "concurrent.txt", "other machine's work\n", "Concurrent parent advance");
        git(publisher.directory, ["push", "origin", "main"]);
        concurrentTip = git(publisher.directory, ["rev-parse", "main"]);
        assert.notEqual(concurrentTip, parentBefore);
      }
      return push(...args);
    };
    await assert.rejects(() => finishBranch(repo, { chooseDisposition: async () => "delete" }), error => error.name === "GitError");
    assert.ok(concurrentTip, "the remote advanced after Finish captured its lease");
    assert.equal(git(remote, ["rev-parse", "main"]), concurrentTip);
    assert.equal(git(remote, ["rev-parse", "feature"]), featureBefore, "atomic refusal also retains the feature branch");
    assert.equal(await repo.hash("main"), parentBefore);
    assert.equal(await repo.hash("feature"), featureBefore);
    assert.equal(await repo.currentBranch(), "feature");
    assert.equal(await repo.statusPorcelain(), "");
    assert.equal(git(directory, ["show", "main:main.txt"]), "baseline");
    const [receipt] = await inspectIncompleteOperations(repo);
    assert.equal(receipt.plan.command, "Finish Branch");
    assert.equal(receipt.phase, "before-remote-push");
    assert.equal(existsSync(await commandLockPath(repo)), false);
  });
}

async function run() {
  for (const command of ["finish", "condense"]) {
    const dispositions = command === "finish" ? ["retain", "delete"] : [undefined];
    for (const disposition of dispositions) {
      for (const interruption of interruptions) await interruptedLifecycle(command, disposition, interruption);
      if (command === "finish") {
        for (const after of [false, true]) {
          await interruptedLifecycle(command, disposition, {
            method: "replaceConfigValues", after, phase: "before-configuration",
            published: true, moved: true, checkout: "destination",
            configurationRemoved: disposition === "delete" && after,
          });
        }
      }
      await interruptedLifecycle(command, disposition, {
        method: "relation", after: false,
        phase: command === "finish" ? "after-configuration" : "after-checkout",
        published: true, moved: true, checkout: "destination",
        configurationRemoved: disposition === "delete", configurationComplete: true,
      });
    }
  }
  await parentAdvancesDuringFinish();
  console.log("WipStream lifecycle interruptions, recovery, and remote lease tests passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
