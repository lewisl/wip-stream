// Preserve realistic ordinary clones for workflow exercises and interactive UI testing.
const assert = require("assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");
const { GitRepository } = require("../out/git");
const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
const { createProjectBackup } = require("../out/project-backup");
const { getFromRemote } = require("../out/generalized-workflow");
const { git, identity, commitFile, heads } = require("./setup-fixture");

function readFixture(directory) {
  if (!directory || !existsSync(path.join(directory, "setup-usage.json"))) {
    throw new Error("Pass the preserved usage-test directory printed by --bootstrap.");
  }
  return JSON.parse(readFileSync(path.join(directory, "setup-usage.json"), "utf8"));
}

function instructions(fixture) {
  return `# Realistic WipStream setup usage test

This sandbox uses a local bare remote and independent ordinary clones. No
extension was installed, no existing project was modified, and no backup will
be deleted automatically. Keep this directory until testing is complete.

Root: ${fixture.root}
Remote: ${fixture.remote}
Backup parent: ${fixture.backups}

## Workflow exercise available after Step 3

Run from the WipStream development repository:

    npm run test:setup-usage -- --verify ${fixture.root}
    npm run test:setup-usage -- --exercise ${fixture.root}
    npm run test:setup-usage -- --adopt ${fixture.root}

The exercise checkpoints and publishes first-machine work, initializes the
additional machine, retains a divergent checkpoint, completes a merge using
Git, retries initialization, and verifies a complete adoption-machine backup.
It mutates only this disposable local remote and these clones. The fixture and
backup remain available afterward. Use a fresh bootstrap for repeated first-use
tests, since the exercise intentionally advances repository state.

## Interactive Extension Development Host test after Step 6

Open the WipStream source in VS Code, choose Run Extension, and press F5.
In the spawned Extension Development Host, open each selected clone as its
workspace with File > Open Folder. This does not install the extension.
Use Initialize Repository:

1. first-machine: choose Commit this machine’s work and save to remote. Verify
   additions, staged/unstaged edits, deletion, existing commits, local-only
   branches, the default checkout, and preservation of build/ and .env.
2. additional-machine: retrieve the published work through Initialize. Verify
   every ordinary branch exists, with the remote default checked out.
3. copied-machine: its copied initialization marker must not bypass inspection
   of its dirty files or current histories.
4. adoption-machine: choose Use the remote’s version and Copy project, then use
   remote. Check that the folder picker starts at the project's parent; choose
   ${fixture.backups}. Verify the full displayed backup path and Open Backup
   Folder. Open that ordinary folder and inspect dirty files, ignored files,
   local-only history, tags, and Git's staged state. Verify no remote refs moved.
   Use a fresh bootstrap to exercise explicit discard and dialog cancellation.
5. divergent-machine: choose Commit this machine’s work and save to remote.
   Verify the local checkpoint remains and nothing is published. In your Git
   tool, merge origin/main into main and complete the merge. Rerun Initialize
   and choose the local-work path; verify that it publishes the existing merge.
6. Cancel each dialog and edit a file/buffer while a preview or commit-message
   prompt is open. Verify fresh preview or cancellation rather than success.

--exercise performs its own merges and initialization, so bootstrap a separate
fixture for interactive first-use testing. Building the VSIX and automated
workflow success do not replace this interactive UI check.
`;
}

function bootstrap() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wipstream-setup-usage-")));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const backups = path.join(root, "backups");
  mkdirSync(backups);
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", seed]);
  identity(seed);
  writeFileSync(path.join(seed, ".gitignore"), "build/\n.env\n");
  writeFileSync(path.join(seed, "obsolete.txt"), "delete this during first-machine setup\n");
  commitFile(seed, "app.txt", "project baseline\n", "Project baseline");
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(seed, ["switch", "-c", "feature/shared"]);
  commitFile(seed, "shared.txt", "shared branch\n", "Shared branch");
  git(seed, ["push", "origin", "feature/shared"]);
  git(seed, ["switch", "main"]);
  const machines = {};
  for (const name of ["first-machine", "additional-machine", "copied-machine", "adoption-machine", "divergent-machine"]) {
    const directory = path.join(root, name);
    git(root, ["clone", remote, directory]);
    identity(directory);
    machines[name] = directory;
  }
  const first = machines["first-machine"];
  git(first, ["switch", "-c", "local/first-work"]);
  commitFile(first, "existing-commit.txt", "already committed locally\n", "Existing first-machine work");
  writeFileSync(path.join(first, "app.txt"), "staged first-machine edit\n");
  git(first, ["add", "app.txt"]);
  writeFileSync(path.join(first, "app.txt"), "final unstaged first-machine edit\n");
  writeFileSync(path.join(first, "new-work.txt"), "first-machine addition\n");
  unlinkSync(path.join(first, "obsolete.txt"));
  mkdirSync(path.join(first, "build"));
  writeFileSync(path.join(first, "build", "cache.txt"), "ignored first-machine cache\n");
  writeFileSync(path.join(first, ".env"), "USAGE_TEST_ONLY=true\n");
  const copied = machines["copied-machine"];
  git(copied, ["config", "wipstream.remote", "origin"]);
  writeFileSync(path.join(copied, "copied-work.txt"), "unsaved copied-machine work\n");
  const adoption = machines["adoption-machine"];
  commitFile(adoption, "local-history.txt", "history to preserve in backup\n", "Adoption machine local commit");
  git(adoption, ["switch", "-c", "local/archive"]);
  commitFile(adoption, "archive.txt", "local-only branch history\n", "Local archive");
  git(adoption, ["tag", "local-backup-tag"]);
  writeFileSync(path.join(adoption, "app.txt"), "staged adoption edit\n");
  git(adoption, ["add", "app.txt"]);
  writeFileSync(path.join(adoption, "app.txt"), "unstaged adoption edit\n");
  writeFileSync(path.join(adoption, "untracked.txt"), "recover from backup\n");
  mkdirSync(path.join(adoption, "build"));
  writeFileSync(path.join(adoption, "build", "cache.txt"), "ignored adoption cache\n");
  const divergent = machines["divergent-machine"];
  commitFile(divergent, "local-side.txt", "desired local history\n", "Independent local history");
  writeFileSync(path.join(divergent, "checkpoint.txt"), "checkpoint before reconciliation\n");
  commitFile(seed, "remote-side.txt", "desired remote history\n", "Independent remote history");
  git(seed, ["push", "origin", "main"]);
  const fixture = { root, remote, backups, machines };
  writeFileSync(path.join(root, "setup-usage.json"), JSON.stringify(fixture, null, 2) + "\n");
  writeFileSync(path.join(root, "USAGE_TEST.md"), instructions(fixture));
  console.log(`Usage-test root: ${root}`);
  console.log(`Instructions: ${path.join(root, "USAGE_TEST.md")}`);
  console.log(`Verify: npm run test:setup-usage -- --verify ${root}`);
  console.log(`Exercise: npm run test:setup-usage -- --exercise ${root}`);
}

async function verify(fixture) {
  for (const directory of Object.values(fixture.machines)) {
    const repo = await GitRepository.open(directory);
    await repo.assertSingleWorktree();
    assert.equal(git(directory, ["remote", "get-url", "origin"]), fixture.remote);
  }
  assert.match(git(fixture.machines["first-machine"], ["status", "--porcelain"]), /app\.txt/);
  assert.equal(git(fixture.machines["additional-machine"], ["status", "--porcelain"]), "");
  assert.equal(git(fixture.machines["copied-machine"], ["config", "wipstream.remote"]), "origin");
  assert.ok(git(fixture.machines["adoption-machine"], ["show-ref", "refs/heads/local/archive"]));
  const divergent = await GitRepository.open(fixture.machines["divergent-machine"]);
  const inspection = await inspectRepositorySetup(divergent);
  assert.deepEqual(inspection.reconciliationBranches, ["main"]);
  console.log(`Seeded ordinary-clone usage fixture verified: ${fixture.root}`);
}

async function exercise(fixture) {
  const initialize = async name => {
    const repo = await GitRepository.open(fixture.machines[name]);
    return executeRepositorySetup(repo, await inspectRepositorySetup(repo), { kind: "local-work" }, {
      requestCheckpointMessage: async () => `Usage test: ${name}`,
    });
  };
  for (const name of ["first-machine", "additional-machine"]) {
    const result = await initialize(name);
    assert.equal(result.kind, "completed", result.message);
    assert.equal(result.checkout, "main");
  }
  const before = heads(fixture.remote);
  const divergent = await initialize("divergent-machine");
  assert.equal(divergent.kind, "reconciliation-required");
  assert.equal(divergent.checkpointCreated, true);
  assert.equal(heads(fixture.remote), before);
  git(fixture.machines["divergent-machine"], ["merge", "--no-edit", "origin/main"]);
  assert.equal((await initialize("divergent-machine")).kind, "completed");
  for (const name of ["first-machine", "additional-machine"]) {
    await getFromRemote(await GitRepository.open(fixture.machines[name]));
    assert.equal(heads(fixture.machines[name]), heads(fixture.remote));
  }
  const adoption = await GitRepository.open(fixture.machines["adoption-machine"]);
  const backup = await createProjectBackup(adoption, fixture.backups);
  assert.equal(heads(backup.path), heads(adoption.root));
  assert.equal(readFileSync(path.join(backup.path, "app.txt"), "utf8"), "unstaged adoption edit\n");
  assert.equal(readFileSync(path.join(backup.path, "build", "cache.txt"), "utf8"), "ignored adoption cache\n");
  console.log(`Local setup, external reconciliation, retry, retrieval, and complete backup exercised: ${fixture.root}`);
  console.log(`Verified backup preserved: ${backup.path}`);
  console.log("Run --adopt with this fixture to exercise remote adoption. Interactive VS Code dialogs remain a separate check.");
}

async function adopt(fixture) {
  const repo = await GitRepository.open(fixture.machines["adoption-machine"]);
  const beforeRemote = heads(fixture.remote);
  const beforeLocal = heads(repo.root);
  const result = await executeRepositorySetup(repo, await inspectRepositorySetup(repo), {
    kind: "remote", backup: { kind: "copy", parent: fixture.backups },
  });
  assert.equal(result.kind, "completed", result.message);
  assert.equal(result.published, false);
  assert.equal(result.checkpointCreated, false);
  assert.equal(heads(fixture.remote), beforeRemote);
  assert.equal(heads(repo.root), beforeRemote);
  assert.equal(heads(result.backupPath), beforeLocal);
  assert.equal(readFileSync(path.join(result.backupPath, "untracked.txt"), "utf8"), "recover from backup\n");
  assert.equal(readFileSync(path.join(repo.root, "build", "cache.txt"), "utf8"), "ignored adoption cache\n");
  console.log(`Remote adoption exercised without pushing or creating a checkpoint: ${fixture.root}`);
  console.log(`All-branch parity verified; original work/history preserved at ${result.backupPath}`);
}

async function main() {
  const [mode = "--bootstrap", directory] = process.argv.slice(2);
  if (mode === "--bootstrap") return bootstrap();
  const fixture = readFixture(directory);
  if (mode === "--verify") return verify(fixture);
  if (mode === "--exercise") return exercise(fixture);
  if (mode === "--adopt") return adopt(fixture);
  throw new Error("Use --bootstrap, --verify <fixture>, --exercise <fixture>, or --adopt <fixture>.");
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
