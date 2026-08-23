const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { GeneralizedWorkflowError, initializeRepository } = require("../out/generalized-workflow");
const {
  completeOperation,
  inspectIncompleteOperations,
  listOperationReceipts,
  readOperationReceipt,
} = require("../out/operations");
const { readRepositoryConfiguration } = require("../out/repository-model");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Initialize Test"]);
  git(directory, ["config", "user.email", "wipstream-initialize@example.invalid"]);
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

async function cloneRepository(fixture, name) {
  const directory = path.join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, directory]);
  configureIdentity(directory);
  return { directory, repo: await GitRepository.open(directory) };
}

function trackBranches(directory, branches) {
  for (const branch of branches) {
    git(directory, ["branch", "--track", branch, `origin/${branch}`]);
  }
}

function heads(directory, namespace = "refs/heads") {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", namespace]);
}

function branchTip(directory, branch) {
  return git(directory, ["rev-parse", `refs/heads/${branch}`]);
}

async function expectInitializeError(action, code) {
  try {
    await action();
    assert.fail(`Expected Initialize Repository error ${code}`);
  } catch (error) {
    assert.ok(error instanceof GeneralizedWorkflowError, `Expected GeneralizedWorkflowError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
}

async function assertInitializedParity(fixture, clone) {
  assert.equal(heads(clone.directory), heads(fixture.remote), "ordinary local and remote branches have complete parity");
  assert.equal(git(clone.directory, ["branch", "--show-current"]), "main");
  assert.deepEqual(await readRepositoryConfiguration(clone.repo), {
    kind: "initialized",
    remote: "origin",
  });
  assert.deepEqual(
    git(clone.directory, ["config", "--get-all", "remote.origin.fetch"]).split("\n"),
    ["+refs/heads/*:refs/remotes/origin/*"]
  );
  for (const line of heads(clone.directory).split("\n").filter(Boolean)) {
    const branch = line.split(" ")[0].replace("refs/heads/", "");
    assert.equal(git(clone.directory, ["config", "--get", `branch.${branch}.remote`]), "origin");
    assert.equal(git(clone.directory, ["config", "--get", `branch.${branch}.merge`]), `refs/heads/${branch}`);
  }
}

async function runFreshCloneInitialization() {
  await withFixture("wipstream-initialize-fresh-", async (fixture) => {
    for (const branch of ["alpha", "beta", "topic/slash"]) {
      publishBranch(fixture.seed, branch);
    }
    const clone = await cloneRepository(fixture, "clone");
    git(clone.directory, [
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);

    const result = await initializeRepository(clone.repo);
    assert.equal(result.checkout, "main");
    assert.deepEqual(result.published, []);
    assert.deepEqual(result.created, ["alpha", "beta", "topic/slash"]);
    assert.deepEqual(result.fastForwarded, []);
    assert.deepEqual(result.deleted, []);
    await assertInitializedParity(fixture, clone);
    const receipt = await readOperationReceipt(clone.repo, result.operationId);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.plan.remoteRefUpdates.length, 0);
    assert.ok(receipt.events.some(({ phase }) => phase === "after-local-refs"));
    assert.equal(receipt.events.at(-1).phase, "completed");
  });
}

async function runBidirectionalInitialization() {
  await withFixture("wipstream-initialize-bidirectional-", async (fixture) => {
    publishBranch(fixture.seed, "local-advance");
    publishBranch(fixture.seed, "remote-advance");
    const clone = await cloneRepository(fixture, "clone");
    trackBranches(clone.directory, ["local-advance", "remote-advance"]);
    const expectedRemoteLocalAdvance = branchTip(clone.directory, "local-advance");

    git(clone.directory, ["switch", "local-advance"]);
    commitFile(clone.directory, "local-advance-2.txt", "local advance\n", "Advance locally");
    const expectedPublishedTip = branchTip(clone.directory, "local-advance");
    git(clone.directory, ["switch", "-c", "local-only", "main"]);
    commitFile(clone.directory, "local-only.txt", "local only\n", "Create local-only");
    const expectedLocalOnlyTip = branchTip(clone.directory, "local-only");

    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/remote-advance"]);
    commitFile(publisher.directory, "remote-advance-2.txt", "remote advance\n", "Advance remotely");
    git(publisher.directory, ["push", "origin", "remote-advance"]);
    const expectedRemoteAdvanceTip = branchTip(publisher.directory, "remote-advance");

    const result = await initializeRepository(clone.repo);
    assert.deepEqual(result.published, ["local-advance", "local-only"]);
    assert.deepEqual(result.fastForwarded, ["remote-advance"]);
    assert.deepEqual(result.created, []);
    assert.equal(branchTip(fixture.remote, "local-advance"), expectedPublishedTip);
    assert.equal(branchTip(fixture.remote, "local-only"), expectedLocalOnlyTip);
    assert.equal(branchTip(clone.directory, "remote-advance"), expectedRemoteAdvanceTip);
    await assertInitializedParity(fixture, clone);

    const receipt = await readOperationReceipt(clone.repo, result.operationId);
    assert.deepEqual(receipt.plan.remoteRefUpdates, [
      { ref: "refs/heads/local-advance", expected: expectedRemoteLocalAdvance, proposed: expectedPublishedTip },
      { ref: "refs/heads/local-only", expected: null, proposed: expectedLocalOnlyTip },
    ]);
    assert.deepEqual(
      receipt.events.map(({ phase }) => phase).filter((phase) => phase.includes("remote-")),
      ["before-remote-push", "after-remote-push", "before-remote-fetch", "after-remote-fetch"]
    );
  });
}

async function runDivergenceRefusal() {
  await withFixture("wipstream-initialize-divergence-", async (fixture) => {
    publishBranch(fixture.seed, "conflict");
    const clone = await cloneRepository(fixture, "clone");
    trackBranches(clone.directory, ["conflict"]);
    git(clone.directory, ["switch", "conflict"]);
    commitFile(clone.directory, "local-side.txt", "local side\n", "Local conflict side");
    git(clone.directory, ["switch", "main"]);

    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/conflict"]);
    commitFile(publisher.directory, "remote-side.txt", "remote side\n", "Remote conflict side");
    git(publisher.directory, ["push", "origin", "conflict"]);
    const localBefore = heads(clone.directory);
    const remoteBefore = heads(fixture.remote);

    const error = await expectInitializeError(
      () => initializeRepository(clone.repo),
      "INITIALIZE_UNSAFE_BRANCHES"
    );
    assert.deepEqual(error.unsafeBranches.map(({ name, relation }) => [name, relation]), [["conflict", "diverged"]]);
    assert.equal(heads(clone.directory), localBefore);
    assert.equal(heads(fixture.remote), remoteBefore);
    assert.equal(git(clone.directory, ["branch", "--show-current"]), "main");
    assert.deepEqual(await readRepositoryConfiguration(clone.repo), { kind: "uninitialized" });
    assert.deepEqual(await listOperationReceipts(clone.repo), []);
  });
}

async function runRemoteSuccessLocalFailureRetry() {
  await withFixture("wipstream-initialize-retry-", async (fixture) => {
    const clone = await cloneRepository(fixture, "clone");
    git(clone.directory, ["switch", "-c", "published-before-failure", "main"]);
    commitFile(clone.directory, "published.txt", "published first\n", "Create branch for interrupted initialize");
    const publishedTip = branchTip(clone.directory, "published-before-failure");
    const localBefore = heads(clone.directory);

    await assert.rejects(
      () => initializeRepository(clone.repo, undefined, {
        afterRemotePush: async () => {
          throw new Error("injected local-phase failure");
        },
      }),
      /injected local-phase failure/
    );
    assert.equal(branchTip(fixture.remote, "published-before-failure"), publishedTip);
    assert.equal(heads(clone.directory), localBefore, "failure after remote success has not partially moved local branches");
    assert.deepEqual(await readRepositoryConfiguration(clone.repo), { kind: "uninitialized" });
    const incomplete = await inspectIncompleteOperations(clone.repo);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].phase, "after-remote-push");
    assert.equal(incomplete[0].plan.remoteRefUpdates[0].ref, "refs/heads/published-before-failure");

    await completeOperation(clone.repo, incomplete[0].plan.operationId);
    const retry = await initializeRepository(clone.repo);
    assert.deepEqual(retry.published, [], "the successful remote publication is authoritative on retry");
    await assertInitializedParity(fixture, clone);
    assert.equal((await inspectIncompleteOperations(clone.repo)).length, 0);
  });
}

Promise.resolve()
  .then(runFreshCloneInitialization)
  .then(runBidirectionalInitialization)
  .then(runDivergenceRefusal)
  .then(runRemoteSuccessLocalFailureRetry)
  .then(() => console.log("WipStream bidirectional Initialize Repository tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
