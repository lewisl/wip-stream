const assert = require("assert/strict");
const { withFixture, git, commitFile } = require("./setup-fixture");
const { repositoryState } = require("./fixture-state");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { commitAndSave, getFromRemote } = require("../out/generalized-workflow");
const { startBranch, condenseBranch } = require("../out/lifecycle-workflow");
const { reconcileWithRemote } = require("../out/conflict-workflow");
const { inspectIncompleteOperations, listOperationReceipts } = require("../out/operations");

async function setup(repo) {
  const result = await executeRepositorySetup(repo, await inspectRepositorySetup(repo), { kind: "local-work" });
  assert.equal(result.kind, "completed", result.message);
}

async function unchangedRefusal(repo, remote, action, code) {
  const before = await repositoryState(repo, remote);
  const receipts = await listOperationReceipts(repo);
  await assert.rejects(action, error => error.code === code);
  assert.deepEqual(await repositoryState(repo, remote), before, `${code} preserves user state`);
  assert.deepEqual(await listOperationReceipts(repo), receipts, `${code} does not begin an operation`);
  assert.deepEqual(await inspectIncompleteOperations(repo), []);
}

async function startRefusals() {
  for (const condition of ["invalid", "local-existing", "remote-existing", "detached"]) {
    await withFixture(async ({ clone, remote, seed }) => {
      const { repo, directory } = await clone("worker");
      await setup(repo);
      let name = "new-topic";
      let code;
      if (condition === "invalid") {
        name = "invalid branch name";
        assert.throws(() => git(directory, ["check-ref-format", "--branch", name]));
        code = "INVALID_BRANCH";
      } else if (condition === "local-existing") {
        git(directory, ["branch", name]);
        assert.equal(await repo.refExists(`refs/heads/${name}`), true);
        code = "BRANCH_EXISTS";
      } else if (condition === "remote-existing") {
        git(seed, ["switch", "-c", name]);
        commitFile(seed, "remote-topic.txt", "remote topic\n");
        git(seed, ["push", "origin", name]);
        await repo.fetchAllBranches("origin");
        assert.equal(await repo.refExists(`refs/heads/${name}`), false);
        assert.equal(await repo.refExists(`refs/remotes/origin/${name}`), true);
        assert.equal(git(remote, ["rev-parse", name]), git(seed, ["rev-parse", name]));
        code = "BRANCH_EXISTS";
      } else {
        await repo.detach();
        assert.equal(await repo.currentBranch(), undefined);
        code = "DETACHED_HEAD";
      }
      await unchangedRefusal(repo, remote, () => startBranch(repo, name), code);
    });
  }
}

async function condenseRefusals() {
  for (const condition of ["zero", "one", "declined", "dismissed", "message-cancelled", "message-blank", "parent-moved"]) {
    await withFixture(async ({ clone, remote }) => {
      const { repo, directory } = await clone("worker");
      await setup(repo);
      await startBranch(repo, "feature");
      const count = condition === "zero" ? 0 : condition === "one" ? 1 : 2;
      for (let i = 0; i < count; i++) commitFile(directory, `change-${i}.txt`, `change ${i}\n`, `Change ${i}`);
      assert.equal((await commitAndSave(repo)).published, true);
      assert.equal(git(directory, ["rev-list", "--count", "main..feature"]), String(count));
      if (condition === "parent-moved") {
        await repo.switch("main");
        commitFile(directory, "parent.txt", "independent parent work\n");
        assert.equal((await commitAndSave(repo)).published, true);
        await repo.switch("feature");
        assert.equal(await repo.isAncestor("main", "feature"), false);
      }
      let previewCalls = 0;
      let messageCalls = 0;
      const options = {
        confirmPreview: async preview => {
          previewCalls++;
          assert.equal(preview.branch, "feature");
          assert.equal(preview.exclusiveCommits, 2);
          return condition === "declined" ? false : condition === "dismissed" ? undefined : true;
        },
        requestMessage: async () => {
          messageCalls++;
          return condition === "message-cancelled" ? undefined : condition === "message-blank" ? "  \t " : "Condensed";
        },
      };
      const code = count < 2 ? "NOTHING_TO_CONDENSE"
        : condition === "parent-moved" ? "PARENT_UPDATE_REQUIRED"
        : condition.startsWith("message-") ? "INVALID_CHECKPOINT_MESSAGE" : "CANCELLED";
      await unchangedRefusal(repo, remote, () => condenseBranch(repo, options), code);
      assert.equal(previewCalls, count < 2 || condition === "parent-moved" ? 0 : 1);
      assert.equal(messageCalls, condition.startsWith("message-") ? 1 : 0);
    });
  }
}

async function reconcileRefusals() {
  for (const relation of ["equal", "local-ahead", "remote-ahead"]) {
    await withFixture(async ({ clone, remote }) => {
      const { repo, directory } = await clone("worker");
      await setup(repo);
      if (relation === "local-ahead") commitFile(directory, "local.txt", "local\n");
      if (relation === "remote-ahead") {
        const publisher = await clone("publisher");
        commitFile(publisher.directory, "remote.txt", "remote\n");
        git(publisher.directory, ["push", "origin", "main"]);
      }
      await repo.fetchAllBranches("origin");
      const expected = relation === "local-ahead" ? "ahead" : relation === "remote-ahead" ? "behind" : "equal";
      assert.equal(await repo.relation("refs/heads/main", "refs/remotes/origin/main"), expected);
      await unchangedRefusal(repo, remote, () => reconcileWithRemote(repo), "CURRENT_BRANCH_NOT_DIVERGED");
    });
  }
  await withFixture(async ({ clone, remote }) => {
    const { repo, directory } = await clone("worker");
    await setup(repo);
    await startBranch(repo, "topic");
    await commitAndSave(repo);
    const publisher = await clone("publisher");
    for (const branch of ["main", "topic"]) {
      await repo.switch(branch);
      commitFile(directory, `local-${branch}.txt`, "local\n");
      git(publisher.directory, ["switch", branch]);
      commitFile(publisher.directory, `remote-${branch}.txt`, "remote\n");
      git(publisher.directory, ["push", "origin", branch]);
    }
    await repo.switch("main");
    await repo.fetchAllBranches("origin");
    for (const branch of ["main", "topic"]) {
      assert.equal(await repo.relation(`refs/heads/${branch}`, `refs/remotes/origin/${branch}`), "diverged");
    }
    await unchangedRefusal(repo, remote, () => reconcileWithRemote(repo), "OTHER_DIVERGENCE");
  });
}

async function anotherCloneAfterCondense() {
  await withFixture(async ({ clone, remote }) => {
    const { repo, directory } = await clone("worker");
    await setup(repo);
    await startBranch(repo, "feature");
    commitFile(directory, "one.txt", "one\n");
    commitFile(directory, "two.txt", "two\n");
    await commitAndSave(repo);
    const observer = await clone("observer");
    await setup(observer.repo);
    await observer.repo.switch("feature");
    const oldTip = await observer.repo.hash("feature");
    const oldTree = git(observer.directory, ["rev-parse", "feature^{tree}"]);
    assert.equal(await observer.repo.relation("feature", "origin/feature"), "equal");
    const condensed = await condenseBranch(repo, { confirmPreview: async () => true, requestMessage: async () => "One feature commit" });
    assert.notEqual(condensed.newTip, oldTip);
    assert.equal(git(remote, ["rev-parse", "feature^{tree}"]), oldTree);
    assert.equal(git(remote, ["rev-list", "--count", "main..feature"]), "1");
    await observer.repo.fetchAllBranches("origin");
    assert.equal(await observer.repo.relation("feature", "origin/feature"), "diverged");
    const beforeGet = await repositoryState(observer.repo, remote);
    await assert.rejects(() => getFromRemote(observer.repo), error => error.code === "GET_UNSAFE_BRANCHES"
      && error.unsafeBranches.some(branch => branch.name === "feature" && branch.relation === "diverged"));
    assert.deepEqual(await repositoryState(observer.repo, remote), beforeGet);
    assert.equal(await observer.repo.hash("feature"), oldTip);
    assert.deepEqual(await inspectIncompleteOperations(observer.repo), []);
  });
}

async function run() {
  await startRefusals();
  await condenseRefusals();
  await reconcileRefusals();
  await anotherCloneAfterCondense();
  console.log("WipStream lifecycle and conflict refusal fixtures passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
