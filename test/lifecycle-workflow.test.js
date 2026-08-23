const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { commitAndSave, initializeRepository } = require("../out/generalized-workflow");
const {
  LifecycleWorkflowError,
  condenseBranch,
  finishBranch,
  startBranch,
  updateFromParent,
} = require("../out/lifecycle-workflow");
const { readOperationReceipt, recoveryRef } = require("../out/operations");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Lifecycle Test"]);
  git(directory, ["config", "user.email", "wipstream-lifecycle@example.invalid"]);
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
  commitFile(seed, `${branch}.txt`, `${branch}\n`, `Create ${branch}`);
  git(seed, ["push", "-u", "origin", branch]);
  git(seed, ["switch", "main"]);
}

async function cloneRepository(fixture, name) {
  const directory = path.join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, directory]);
  configureIdentity(directory);
  const repo = await GitRepository.open(directory);
  await initializeRepository(repo);
  return { directory, repo };
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

function configValue(directory, key) {
  try {
    return git(directory, ["config", "--get", key]);
  } catch {
    return undefined;
  }
}

async function expectLifecycleError(action, code) {
  try {
    await action();
    assert.fail(`Expected lifecycle error ${code}`);
  } catch (error) {
    assert.ok(error instanceof LifecycleWorkflowError, `Expected LifecycleWorkflowError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
}

async function runStartCarriesWork() {
  await withFixture("wipstream-lifecycle-start-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone");
    const parentTip = branchTip(clone.directory, "main");
    writeFileSync(path.join(clone.directory, "main.txt"), "modified but uncommitted\n");
    writeFileSync(path.join(clone.directory, "draft.txt"), "untracked draft\n");

    const result = await startBranch(clone.repo, "feature/draft");
    assert.equal(result.branch, "feature/draft");
    assert.equal(result.parent, "main");
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "feature/draft");
    assert.equal(branchTip(clone.directory, "feature/draft"), parentTip, "Start does not auto-commit carried work");
    assert.match(git(clone.directory, ["status", "--porcelain=v1"]), /draft\.txt/);
    assert.match(git(clone.directory, ["status", "--porcelain=v1"]), /main\.txt/);
    assert.equal(
      git(clone.directory, ["config", "--get", "branch.feature/draft.wipstreamParent"]),
      "main"
    );
    const receipt = await readOperationReceipt(clone.repo, result.operationId);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(receipt.plan.checkout, { before: "main", after: "feature/draft" });
    assert.equal(branchExists(fixture.remote, "feature/draft"), false);
  });
}

async function runFinishAdvisoryUpdateAndChoices() {
  await withFixture("wipstream-lifecycle-finish-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone");

    await startBranch(clone.repo, "branch-b");
    writeFileSync(path.join(clone.directory, "branch-b-work.txt"), "branch b\n");
    await commitAndSave(clone.repo, { requestCheckpointMessage: async () => "Checkpoint branch B" });

    git(clone.directory, ["switch", "main"]);
    await startBranch(clone.repo, "branch-a");
    writeFileSync(path.join(clone.directory, "branch-a-work.txt"), "branch a\n");
    const finishedA = await finishBranch(clone.repo, {
      save: { requestCheckpointMessage: async () => "Checkpoint branch A" },
      chooseDisposition: async () => "retain",
    });
    assert.equal(finishedA.disposition, "retain");
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "main");
    assert.equal(branchTip(clone.directory, "main"), branchTip(clone.directory, "branch-a"));
    assert.equal(branchExists(clone.directory, "branch-a"), true);
    assert.equal(branchExists(fixture.remote, "branch-a"), true);

    git(clone.directory, ["switch", "branch-b"]);
    const advisorySave = await commitAndSave(clone.repo);
    assert.equal(advisorySave.published, true, "parent advisories do not block Save");
    assert.deepEqual(advisorySave.advisories.find(({ branch }) => branch === "branch-b"), {
      branch: "branch-b",
      parent: "main",
      source: "recorded",
      state: "parent-advanced",
    });

    let dispositionAsked = false;
    const refusal = await expectLifecycleError(
      () => finishBranch(clone.repo, {
        chooseDisposition: async () => {
          dispositionAsked = true;
          return "retain";
        },
      }),
      "PARENT_UPDATE_REQUIRED"
    );
    assert.match(refusal.message, /Update from Parent/);
    assert.equal(dispositionAsked, false, "Finish validates ancestry before asking about deletion");

    const updated = await updateFromParent(clone.repo);
    assert.equal(updated.updated, true);
    assert.equal(updated.parent, "main");
    assert.equal(await clone.repo.isAncestor("main", "branch-b"), true);
    assert.ok(git(clone.directory, ["rev-list", "--parents", "-n", "1", "branch-b"]).split(" ").length >= 3);

    const finishedB = await finishBranch(clone.repo, { chooseDisposition: async () => "delete" });
    assert.equal(finishedB.disposition, "delete");
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "main");
    assert.equal(branchExists(clone.directory, "branch-b"), false);
    assert.equal(branchExists(fixture.remote, "branch-b"), false);
    assert.equal(configValue(clone.directory, "branch.branch-b.wipstreamParent"), undefined);

    const afterIntegration = await commitAndSave(clone.repo);
    assert.deepEqual(afterIntegration.advisories.find(({ branch }) => branch === "branch-a"), {
      branch: "branch-a",
      parent: "main",
      source: "recorded",
      state: "probably-integrated",
    });
  });
}

async function runImportedParentConfirmation() {
  await withFixture("wipstream-lifecycle-imported-", async (fixture) => {
    publishBranch(fixture.seed, "imported");
    const clone = await cloneRepository(fixture, "clone");
    git(clone.directory, ["switch", "imported"]);
    const saved = await commitAndSave(clone.repo);
    assert.equal(saved.published, true);
    assert.deepEqual(saved.advisories.find(({ branch }) => branch === "imported"), {
      branch: "imported",
      parent: "main",
      source: "assumed-default",
      state: "current",
    });

    await expectLifecycleError(() => updateFromParent(clone.repo), "PARENT_CONFIRMATION_REQUIRED");
    let assumed;
    const result = await updateFromParent(clone.repo, async (candidate) => {
      assumed = candidate;
      return candidate;
    });
    assert.equal(assumed, "main");
    assert.equal(result.updated, false);
    assert.equal(git(clone.directory, ["config", "--get", "branch.imported.wipstreamParent"]), "main");
  });
}

async function runCondense() {
  await withFixture("wipstream-lifecycle-condense-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone");
    await startBranch(clone.repo, "checkpoint-heavy");
    for (const ordinal of [1, 2, 3]) {
      commitFile(
        clone.directory,
        `checkpoint-${ordinal}.txt`,
        `checkpoint ${ordinal}\n`,
        `Checkpoint ${ordinal}`
      );
    }
    await commitAndSave(clone.repo);
    const oldTip = branchTip(clone.directory, "checkpoint-heavy");
    const oldTree = git(clone.directory, ["rev-parse", "checkpoint-heavy^{tree}"]);
    let preview;

    const result = await condenseBranch(clone.repo, {
      confirmPreview: async (candidate) => {
        preview = candidate;
        return true;
      },
      requestMessage: async (suggested) => {
        assert.equal(suggested, "Condense checkpoint-heavy");
        return "One intentional feature commit";
      },
    });
    assert.deepEqual(preview, {
      branch: "checkpoint-heavy",
      parent: "main",
      oldTip,
      exclusiveCommits: 3,
    });
    assert.notEqual(result.newTip, oldTip);
    assert.equal(branchTip(clone.directory, "checkpoint-heavy"), result.newTip);
    assert.equal(branchTip(fixture.remote, "checkpoint-heavy"), result.newTip);
    assert.equal(git(clone.directory, ["rev-parse", "checkpoint-heavy^{tree}"]), oldTree);
    assert.equal(git(clone.directory, ["rev-parse", "checkpoint-heavy^1"]), branchTip(clone.directory, "main"));
    assert.equal(git(clone.directory, ["rev-list", "--count", "main..checkpoint-heavy"]), "1");
    assert.equal(git(clone.directory, ["log", "-1", "--format=%s"]), "One intentional feature commit");
    assert.equal(git(clone.directory, ["rev-parse", recoveryRef(result.operationId, 0)]), oldTip);
    const receipt = await readOperationReceipt(clone.repo, result.operationId);
    assert.equal(receipt.plan.remoteRefUpdates[0].expected, oldTip);
    assert.deepEqual(receipt.plan.destructiveEffects.map(({ kind }) => kind), [
      "rewrite-remote-ref",
      "rewrite-local-ref",
    ]);
  });
}

Promise.resolve()
  .then(runStartCarriesWork)
  .then(runFinishAdvisoryUpdateAndChoices)
  .then(runImportedParentConfirmation)
  .then(runCondense)
  .then(() => console.log("WipStream parent-aware lifecycle tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
