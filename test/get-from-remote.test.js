const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { GeneralizedWorkflowError, getFromRemote } = require("../out/generalized-workflow");
const { readOperationReceipt, recoveryRef, listOperationReceipts } = require("../out/operations");
const { setBranchParent, writeRepositoryConfiguration } = require("../out/repository-model");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Get Test"]);
  git(directory, ["config", "user.email", "wipstream-get@example.invalid"]);
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
  const repo = await GitRepository.open(directory);
  return { directory, repo };
}

function trackBranches(directory, branches) {
  for (const branch of branches) {
    git(directory, ["branch", "--track", branch, `origin/${branch}`]);
  }
}

function localHeads(directory) {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
}

function remoteHeads(directory) {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/origin"])
    .split("\n")
    .filter((line) => line && !line.startsWith("refs/remotes/origin/HEAD "))
    .map((line) => line.replace("refs/remotes/origin/", "refs/heads/"))
    .join("\n");
}

function branchExists(directory, branch) {
  try {
    git(directory, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function expectGetError(action, code) {
  try {
    await action();
    assert.fail(`Expected generalized Get error ${code}`);
  } catch (error) {
    assert.ok(error instanceof GeneralizedWorkflowError, `Expected GeneralizedWorkflowError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
}

async function runSafeMultiBranchGet() {
  await withFixture("wipstream-get-safe-", async (fixture) => {
    for (const branch of ["alpha", "deleted", "topic/slash"]) {
      publishBranch(fixture.seed, branch);
    }
    const first = await cloneRepository(fixture, "first");
    trackBranches(first.directory, ["alpha", "deleted", "topic/slash"]);
    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    await setBranchParent(first.repo, "alpha", "main");
    git(first.directory, [
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);

    const publisher = await cloneRepository(fixture, "publisher");
    commitFile(publisher.directory, "main-advance.txt", "new main files\n", "Advance main");
    git(publisher.directory, ["push", "origin", "main"]);
    git(publisher.directory, ["switch", "--track", "origin/alpha"]);
    commitFile(publisher.directory, "alpha-advance.txt", "new alpha files\n", "Advance alpha");
    git(publisher.directory, ["push", "origin", "alpha"]);
    git(publisher.directory, ["switch", "-c", "remote-only", "main"]);
    commitFile(publisher.directory, "remote-only.txt", "remote only\n", "Create remote-only");
    git(publisher.directory, ["push", "-u", "origin", "remote-only"]);
    git(publisher.directory, ["push", "origin", ":deleted"]);

    const result = await getFromRemote(first.repo);
    assert.equal(result.updated, true);
    assert.equal(result.checkout, "main");
    assert.equal(git(first.directory, ["branch", "--show-current"]), "main");
    assert.equal(readFileSync(path.join(first.directory, "main-advance.txt"), "utf8"), "new main files\n");
    assert.deepEqual(result.created, ["remote-only"]);
    assert.deepEqual(result.fastForwarded, ["alpha", "main"]);
    assert.deepEqual(result.deleted, ["deleted"]);
    assert.equal(branchExists(first.directory, "deleted"), false);
    assert.equal(git(first.directory, ["config", "--get", "branch.remote-only.remote"]), "origin");
    assert.equal(git(first.directory, ["config", "--get", "branch.remote-only.merge"]), "refs/heads/remote-only");
    assert.equal(localHeads(first.directory), remoteHeads(first.directory), "successful Get establishes complete branch parity");
    assert.equal(git(first.directory, ["status", "--porcelain=v1"]), "");

    const receipt = await readOperationReceipt(first.repo, result.operationId);
    assert.equal(receipt.status, "completed");
    for (const [ordinal, update] of receipt.plan.localRefUpdates.entries()) {
      if (update.expectedOld !== null) {
        assert.equal(git(first.directory, ["rev-parse", recoveryRef(result.operationId, ordinal)]), update.expectedOld);
      }
    }
    const alphaAdvisory = result.advisories.find(({ branch }) => branch === "alpha");
    assert.deepEqual(alphaAdvisory, {
      branch: "alpha",
      parent: "main",
      source: "recorded",
      state: "parent-advanced",
    });

    const repeated = await getFromRemote(first.repo);
    assert.equal(repeated.updated, false, "repeating successful Get is idempotent");
    assert.deepEqual(repeated.created, []);
    assert.deepEqual(repeated.fastForwarded, []);
    assert.deepEqual(repeated.deleted, []);
    assert.equal(localHeads(first.directory), remoteHeads(first.directory));
  });
}

async function runUnsafeAllOrNothingRefusal() {
  await withFixture("wipstream-get-refusal-", async (fixture) => {
    publishBranch(fixture.seed, "conflict");
    const first = await cloneRepository(fixture, "first");
    trackBranches(first.directory, ["conflict"]);
    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    git(first.directory, ["switch", "conflict"]);
    commitFile(first.directory, "local-conflict.txt", "local side\n", "Local conflict side");
    git(first.directory, ["switch", "main"]);
    const beforeHeads = localHeads(first.directory);
    const beforeMain = readFileSync(path.join(first.directory, "main.txt"), "utf8");

    const publisher = await cloneRepository(fixture, "publisher");
    commitFile(publisher.directory, "remote-main.txt", "safe remote advance\n", "Advance remote main");
    git(publisher.directory, ["push", "origin", "main"]);
    git(publisher.directory, ["switch", "--track", "origin/conflict"]);
    commitFile(publisher.directory, "remote-conflict.txt", "remote side\n", "Remote conflict side");
    git(publisher.directory, ["push", "origin", "conflict"]);

    const error = await expectGetError(() => getFromRemote(first.repo), "GET_UNSAFE_BRANCHES");
    assert.deepEqual(error.unsafeBranches.map(({ name, relation }) => [name, relation]), [["conflict", "diverged"]]);
    assert.equal(localHeads(first.directory), beforeHeads, "one unsafe branch prevents every ordinary local ref update");
    assert.equal(readFileSync(path.join(first.directory, "main.txt"), "utf8"), beforeMain);
    assert.equal(git(first.directory, ["branch", "--show-current"]), "main");
    assert.equal(
      git(first.directory, ["rev-parse", "refs/remotes/origin/main"]),
      git(publisher.directory, ["rev-parse", "main"]),
      "fetch may update remote-tracking refs on refusal"
    );
    assert.deepEqual(await listOperationReceipts(first.repo), [], "preflight refusal creates no mutation receipt");

    await expectGetError(() => getFromRemote(first.repo), "GET_UNSAFE_BRANCHES");
    assert.equal(localHeads(first.directory), beforeHeads, "repeating a refused Get is idempotent");
  });
}

async function runDeletedCurrentBranchFallbacks() {
  await withFixture("wipstream-get-parent-fallback-", async (fixture) => {
    publishBranch(fixture.seed, "parent");
    publishBranch(fixture.seed, "child", "parent");
    const first = await cloneRepository(fixture, "first");
    trackBranches(first.directory, ["parent", "child"]);
    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    await setBranchParent(first.repo, "child", "parent");
    git(first.directory, ["switch", "child"]);

    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["push", "origin", ":child"]);
    const result = await getFromRemote(first.repo);
    assert.equal(result.checkout, "parent");
    assert.equal(git(first.directory, ["branch", "--show-current"]), "parent");
    assert.equal(branchExists(first.directory, "child"), false);
    assert.equal(localHeads(first.directory), remoteHeads(first.directory));
  });

  await withFixture("wipstream-get-default-fallback-", async (fixture) => {
    publishBranch(fixture.seed, "parent");
    publishBranch(fixture.seed, "child", "parent");
    const first = await cloneRepository(fixture, "first");
    trackBranches(first.directory, ["parent", "child"]);
    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    await setBranchParent(first.repo, "child", "parent");
    git(first.directory, ["switch", "child"]);

    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["push", "origin", ":child", ":parent"]);
    const result = await getFromRemote(first.repo);
    assert.equal(result.checkout, "main");
    assert.equal(git(first.directory, ["branch", "--show-current"]), "main");
    assert.deepEqual(result.deleted, ["child", "parent"]);
  });
}

async function runAmbiguousDeletionRefusal() {
  await withFixture("wipstream-get-ambiguous-delete-", async (fixture) => {
    publishBranch(fixture.seed, "doomed");
    const first = await cloneRepository(fixture, "first");
    trackBranches(first.directory, ["doomed"]);
    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    git(first.directory, ["switch", "doomed"]);
    commitFile(first.directory, "local-after-fetch.txt", "preserve me\n", "Local work after fetched tip");
    git(first.directory, ["switch", "main"]);
    const before = localHeads(first.directory);

    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["push", "origin", ":doomed"]);
    const error = await expectGetError(() => getFromRemote(first.repo), "GET_UNSAFE_BRANCHES");
    assert.deepEqual(error.unsafeBranches.map(({ name, relation }) => [name, relation]), [["doomed", "remotely-deleted"]]);
    assert.equal(localHeads(first.directory), before);
    assert.equal(branchExists(first.directory, "doomed"), true);
  });
}

Promise.resolve()
  .then(runSafeMultiBranchGet)
  .then(runUnsafeAllOrNothingRefusal)
  .then(runDeletedCurrentBranchFallbacks)
  .then(runAmbiguousDeletionRefusal)
  .then(() => console.log("WipStream transactional Get tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
