const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const {
  RepositoryModelError,
  getBranchParent,
  inspectBranchInventory,
  inspectRepository,
  readRepositoryConfiguration,
  resolveRemoteDefaultBranch,
  setBranchParent,
  snapshotRemoteTips,
  writeRepositoryConfiguration,
} = require("../out/repository-model");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Model Test"]);
  git(directory, ["config", "user.email", "wipstream-model@example.invalid"]);
}

function createFixture(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", seed]);
  configureIdentity(seed);
  writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "README.md"]);
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

async function cloneRepository(fixture, name) {
  const directory = path.join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, directory]);
  configureIdentity(directory);
  return { directory, repo: await GitRepository.open(directory) };
}

function commitFile(directory, name, contents, message) {
  writeFileSync(path.join(directory, name), contents);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

function publishBranch(seed, branch) {
  git(seed, ["switch", "-c", branch, "main"]);
  commitFile(seed, `${branch.replaceAll("/", "-")}.txt`, `${branch}\n`, `Create ${branch}`);
  git(seed, ["push", "-u", "origin", branch]);
  git(seed, ["switch", "main"]);
}

async function expectModelError(action, code) {
  try {
    await action();
    assert.fail(`Expected repository model error ${code}`);
  } catch (error) {
    assert.ok(error instanceof RepositoryModelError, `Expected RepositoryModelError, got ${error}`);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0, `${code} has an actionable message`);
  }
}

function repositoryState(directory) {
  return {
    refs: git(directory, ["show-ref"]),
    config: git(directory, ["config", "--local", "--list"]),
    branch: git(directory, ["branch", "--show-current"]),
  };
}

async function runConfigurationAndParentIntent() {
  await withFixture("wipstream-model-config-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    assert.deepEqual(await readRepositoryConfiguration(first.repo), { kind: "uninitialized" });

    git(first.directory, ["config", "--local", "wipstream.version", "99"]);
    await expectModelError(() => readRepositoryConfiguration(first.repo), "UNSUPPORTED_CONFIG_VERSION");

    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    assert.deepEqual(await readRepositoryConfiguration(first.repo), {
      kind: "version2",
      version: "2",
      remote: "origin",
    });
    await setBranchParent(first.repo, "topic/with-slash", "main");
    assert.equal(await getBranchParent(first.repo, "topic/with-slash"), "main");
    await expectModelError(() => setBranchParent(first.repo, "main", "main"), "INVALID_PARENT_INTENT");
    await expectModelError(() => writeRepositoryConfiguration(first.repo, { remote: "  " }), "INVALID_REPOSITORY_CONFIG");
  });
}

async function runMutationFreeInspection() {
  await withFixture("wipstream-model-inspection-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    git(first.directory, ["config", "--local", "wipstream.version", "1"]);
    const beforeLegacy = repositoryState(first.directory);
    await expectModelError(() => readRepositoryConfiguration(first.repo), "LEGACY_VERSION_UNSUPPORTED");
    await expectModelError(() => inspectRepository(first.repo), "LEGACY_VERSION_UNSUPPORTED");
    assert.deepEqual(repositoryState(first.directory), beforeLegacy, "legacy-version refusal is read-only");

    await writeRepositoryConfiguration(first.repo, { remote: "origin" });
    const beforeV2 = repositoryState(first.directory);
    const v2 = await inspectRepository(first.repo);
    assert.equal(v2.configuration.kind, "version2");
    assert.equal(v2.remoteDefaultBranch, "main");
    assert.deepEqual(repositoryState(first.directory), beforeV2, "version 2 inspection is read-only");
  });
}

async function runInventoryClassification() {
  await withFixture("wipstream-model-inventory-", async (fixture) => {
    for (const branch of ["equal", "local-ahead", "remote-ahead", "rewrite", "deleted", "topic/slash"]) {
      publishBranch(fixture.seed, branch);
    }

    const first = await cloneRepository(fixture, "first");
    for (const branch of ["equal", "local-ahead", "remote-ahead", "rewrite", "deleted", "topic/slash"]) {
      git(first.directory, ["branch", "--track", branch, `origin/${branch}`]);
    }
    git(first.directory, ["switch", "local-ahead"]);
    commitFile(first.directory, "local-advance.txt", "local advance\n", "Advance local branch");
    git(first.directory, ["switch", "main"]);
    git(first.directory, ["branch", "local-only", "main"]);
    git(first.directory, ["remote", "add", "backup", fixture.remote]);
    git(first.directory, ["fetch", "backup"]);
    git(first.directory, ["branch", "--track", "other-tracked", "backup/main"]);

    const previousRemoteTips = await snapshotRemoteTips(first.repo, "origin");
    const publisher = await cloneRepository(fixture, "publisher");
    git(publisher.directory, ["switch", "--track", "origin/remote-ahead"]);
    commitFile(publisher.directory, "remote-advance.txt", "remote advance\n", "Advance remote branch");
    git(publisher.directory, ["push", "origin", "remote-ahead"]);
    git(publisher.directory, ["switch", "-c", "remote-only", "main"]);
    commitFile(publisher.directory, "remote-only.txt", "remote only\n", "Create remote-only branch");
    git(publisher.directory, ["push", "-u", "origin", "remote-only"]);
    const rewrittenTree = git(publisher.directory, ["rev-parse", "main^{tree}"]);
    const rewrittenCommit = git(publisher.directory, ["commit-tree", rewrittenTree, "-m", "Independent rewritten root"]);
    git(publisher.directory, ["push", "--force", "origin", `${rewrittenCommit}:refs/heads/rewrite`]);
    git(publisher.directory, ["push", "origin", ":deleted"]);

    await first.repo.fetch("origin");
    const mainHash = git(first.directory, ["rev-parse", "main"]);
    git(first.directory, ["tag", "release-baseline", mainHash]);
    git(first.directory, ["update-ref", "refs/wipstream/recovery/test/0", mainHash]);

    const inventory = await inspectBranchInventory(first.repo, "origin", previousRemoteTips);
    const byName = new Map(inventory.map((entry) => [entry.name, entry]));
    const expected = {
      main: ["equal", "unchanged", "selected-remote"],
      equal: ["equal", "unchanged", "selected-remote"],
      "local-ahead": ["local-ahead", "unchanged", "selected-remote"],
      "local-only": ["local-only", "unseen", "none"],
      "other-tracked": ["local-only", "unseen", "other-remote"],
      "remote-ahead": ["remote-ahead", "advanced", "selected-remote"],
      "remote-only": ["remote-only", "created", "none"],
      rewrite: ["diverged", "rewritten", "selected-remote"],
      deleted: ["remotely-deleted", "deleted", "selected-remote"],
      "topic/slash": ["equal", "unchanged", "selected-remote"],
    };
    assert.deepEqual([...byName.keys()], Object.keys(expected).sort(), "inventory contains only ordinary selected-remote branches");
    for (const [name, [relation, remoteChange, tracking]] of Object.entries(expected)) {
      const entry = byName.get(name);
      assert.ok(entry, `inventory contains ${name}`);
      assert.equal(entry.relation, relation, `${name} relation`);
      assert.equal(entry.remoteChange, remoteChange, `${name} remote change`);
      assert.equal(entry.tracking, tracking, `${name} tracking`);
      assert.equal(entry.checkedOut, name === "main", `${name} checked-out state`);
    }
    assert.equal(byName.has("HEAD"), false);
    assert.equal(byName.has("release-baseline"), false, "tags are not ordinary branches");
    assert.equal(byName.has("wipstream/recovery/test/0"), false, "internal refs are not ordinary branches");
  });
}

async function runRemoteDefaultFailures() {
  await withFixture("wipstream-model-head-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    assert.equal(await resolveRemoteDefaultBranch(first.repo, "origin"), "main");
    git(first.directory, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    await expectModelError(() => resolveRemoteDefaultBranch(first.repo, "origin"), "REMOTE_HEAD_MISSING");
    git(first.directory, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/not-real"]);
    await expectModelError(() => resolveRemoteDefaultBranch(first.repo, "origin"), "REMOTE_HEAD_AMBIGUOUS");
  });
}

Promise.resolve()
  .then(runConfigurationAndParentIntent)
  .then(runMutationFreeInspection)
  .then(runInventoryClassification)
  .then(runRemoteDefaultFailures)
  .then(() => console.log("WipStream repository model tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
