const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitRepository } = require("../out/git");
const { initialize, resume, saveUp, toFeature, toMain, WorkflowError } = require("../out/workflow");
const contract = require("./v1-contract.json");

const projectRoot = path.resolve(__dirname, "..");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Test"]);
  git(directory, ["config", "user.email", "wipstream-test@example.invalid"]);
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
  return { root, remote };
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

async function expectWorkflowError(action, code) {
  try {
    await action();
    assert.fail(`Expected WipStream error ${code}`);
  } catch (error) {
    assert.ok(error instanceof WorkflowError, `Expected WorkflowError, got ${error}`);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0, `${code} retains an actionable message`);
  }
}

function quotedUnion(source, typeName) {
  const match = new RegExp(`export type ${typeName} = ([^;]+);`).exec(source);
  assert.ok(match, `Expected exported type ${typeName}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((value) => value[1]);
}

function runStaticContract() {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const expectedIds = contract.commands.map((command) => command.id);
  for (const id of expectedIds) {
    assert.ok(packageJson.activationEvents.includes(`onCommand:${id}`), `${id} retains an explicit activation event`);
    assert.ok(packageJson.contributes.commands.some(({ command }) => command === id), `${id} remains declared`);
  }
  const renamedPrimaryCommands = [
    { command: "wipstream.init", title: "Initialize Repository" },
    { command: "wipstream.resume", title: "Get from Remote" },
    { command: "wipstream.saveup", title: "Commit and Save" },
  ];
  assert.deepEqual(
    packageJson.contributes.commands
      .filter(({ command }) => renamedPrimaryCommands.some((expected) => expected.command === command))
      .map(({ command, title }) => ({ command, title })),
    renamedPrimaryCommands,
    "the three primary v1 ids have their planned generalized titles"
  );
  assert.deepEqual(
    packageJson.contributes.keybindings,
    contract.commands.slice(0, 3).map(({ id, key }) => ({ command: id, key })),
    "the three primary v1 ids retain their keybindings while legacy lifecycle chords are retired"
  );

  const workflowSource = readFileSync(path.join(projectRoot, "src", "workflow.ts"), "utf8");
  const commandsSource = readFileSync(path.join(projectRoot, "src", "commands.ts"), "utf8");
  for (const typeName of ["InitializeResult", "ResumeResult", "FinishResult"]) {
    assert.deepEqual(quotedUnion(workflowSource, typeName), contract.resultTypes[typeName]);
  }
  const syncFailure = /readonly failure\?: ([^;]+);/.exec(workflowSource);
  assert.ok(syncFailure, "Expected the v1 SyncResult failure union");
  assert.deepEqual(
    [...syncFailure[1].matchAll(/"([^"]+)"/g)].map((value) => value[1]),
    contract.resultTypes.SyncFailure
  );

  const implementedCodes = [...workflowSource.matchAll(/(?:fail|new WorkflowError)\(\s*"([A-Z_]+)"/g)]
    .map((match) => match[1]);
  const expectedCodes = new Set(contract.errorCodes.map(({ code }) => code));
  for (const code of new Set(implementedCodes)) {
    assert.ok(expectedCodes.has(code), `literal compatibility error ${code} has an explicit expectation`);
  }
  for (const code of ["NO_REPOSITORY", "CANCELLED", "SAVE_FAILED", "UNSAVED_EDITOR_WORK", "INVALID_INPUT"]) {
    assert.match(commandsSource, new RegExp(`new CommandUiError\\(\\s*"${code}"`), `command UI retains ${code}`);
    assert.ok(expectedCodes.has(code), `${code} retains its compatibility expectation`);
  }
  for (const entry of [...contract.commands, ...contract.errorCodes]) {
    assert.ok(entry.compatibility.length > 0, `${entry.id || entry.code} has a compatibility expectation`);
  }
}

async function runResultCharacterization() {
  await withFixture("wipstream-v1-results-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    assert.equal(await initialize(first.repo), "created");
    assert.equal(await initialize(first.repo), "current");
    assert.equal(await resume(first.repo), "current");
    assert.deepEqual(await saveUp(first.repo), { checkpointCreated: false, published: true });
    assert.equal(await toFeature(first.repo), false);

    const second = await cloneRepository(fixture, "second");
    assert.equal(await initialize(second.repo), "attached");
    writeFileSync(path.join(second.directory, "remote-work.txt"), "work from the second clone\n");
    assert.deepEqual(await saveUp(second.repo), { checkpointCreated: true, published: true });

    assert.equal(await resume(first.repo), "resumed");
    assert.equal(await toFeature(first.repo), true);
    assert.equal(await toFeature(first.repo), false);
    assert.equal(await toMain(first.repo), "finished");
    assert.equal(await toMain(first.repo), "already-finished");
    assert.equal(await resume(second.repo), "completed");
  });
}

async function runSaveFailureCharacterization() {
  await withFixture("wipstream-v1-save-results-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    writeFileSync(path.join(first.directory, "offline.txt"), "checkpoint survives an offline handoff\n");
    git(first.directory, ["remote", "set-url", "origin", "ssh://127.0.0.1:1/wipstream.git"]);
    assert.deepEqual(
      await saveUp(first.repo),
      { checkpointCreated: true, published: false, failure: "offline" },
      "offline Save retains its local checkpoint"
    );
    git(first.directory, ["remote", "set-url", "origin", fixture.remote]);
    assert.deepEqual(await saveUp(first.repo), { checkpointCreated: false, published: true });

    const second = await cloneRepository(fixture, "second");
    await initialize(second.repo);
    git(second.directory, ["switch", "feature"]);
    commitFile(second.directory, "feature-race.txt", "remote feature advance\n", "Advance remote feature");
    git(second.directory, ["push", "origin", "feature"]);
    assert.deepEqual(
      await saveUp(first.repo),
      { checkpointCreated: false, published: false, failure: "remote-changed" },
      "a stale atomic push reports a remote change without checkpoint loss"
    );
  });
}

async function runConfigurationFailures() {
  await withFixture("wipstream-v1-config-errors-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await expectWorkflowError(() => resume(first.repo), "NOT_INITIALIZED");
    await expectWorkflowError(() => initialize(first.repo, { featureBranch: "main" }), "INVALID_BRANCH_NAMES");
    await expectWorkflowError(() => initialize(first.repo, { featureBranch: "bad branch" }), "INVALID_BRANCH_NAME");
    await expectWorkflowError(() => initialize(first.repo, { remote: "missing" }), "REMOTE_MISSING");
  });
}

async function runPartialStreamFixtures() {
  await withFixture("wipstream-v1-partial-remote-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    git(first.directory, ["push", "origin", ":feature"]);
    await expectWorkflowError(() => resume(first.repo), "PARTIAL_REMOTE_STREAM");
  });

  await withFixture("wipstream-v1-partial-local-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    git(first.directory, ["branch", "feature", "main"]);
    await expectWorkflowError(() => initialize(first.repo), "PARTIAL_LOCAL_STREAM");
  });
}

async function runUnsafeBranchFixtures() {
  await withFixture("wipstream-v1-local-ahead-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    commitFile(first.directory, "local-only.txt", "local ahead\n", "Local-only WIP commit");
    await expectWorkflowError(() => resume(first.repo), "LOCAL_AHEAD");
  });

  await withFixture("wipstream-v1-diverged-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    const second = await cloneRepository(fixture, "second");
    await initialize(second.repo);
    commitFile(first.directory, "first-only.txt", "first side\n", "First side of divergence");
    writeFileSync(path.join(second.directory, "second-only.txt"), "second side\n");
    await saveUp(second.repo);
    await expectWorkflowError(() => resume(first.repo), "LOCAL_DIVERGED");
  });

  await withFixture("wipstream-v1-unfinished-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    commitFile(first.directory, "unfinished.txt", "must not be discarded\n", "Unfinished local work");
    git(first.directory, ["push", "origin", ":feature", ":wip/feature"]);
    await expectWorkflowError(() => resume(first.repo), "LOCAL_UNFINISHED_WORK");
  });
}

async function runRewriteRefusals() {
  await withFixture("wipstream-v1-rewrite-refusals-", async (fixture) => {
    const first = await cloneRepository(fixture, "first");
    await initialize(first.repo);
    writeFileSync(path.join(first.directory, "one.txt"), "one\n");
    await saveUp(first.repo);
    writeFileSync(path.join(first.directory, "two.txt"), "two\n");
    await saveUp(first.repo);
    git(first.directory, ["reset", "--soft", "HEAD~2"]);
    git(first.directory, ["commit", "-m", "Condensed local WIP"]);
    await expectWorkflowError(() => saveUp(first.repo), "WIP_REWRITE_CONFIRMATION_REQUIRED");
    await expectWorkflowError(() => saveUp(first.repo, undefined, async () => false), "CANCELLED");

    git(first.directory, ["switch", "main"]);
    await expectWorkflowError(() => saveUp(first.repo), "WRONG_BRANCH");
  });
}

Promise.resolve()
  .then(runStaticContract)
  .then(runResultCharacterization)
  .then(runSaveFailureCharacterization)
  .then(runConfigurationFailures)
  .then(runPartialStreamFixtures)
  .then(runUnsafeBranchFixtures)
  .then(runRewriteRefusals)
  .then(() => console.log("WipStream v1 compatibility characterization tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
