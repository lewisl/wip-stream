const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { withFixture, git, commitFile } = require("./setup-fixture");
const { beginOperation, withRecordedOperation, createOperationPlan, readOperationReceipt, inspectIncompleteOperations, renderOperationPreview } = require("../out/operations");
const { initializeRepository, commitAndSave, getFromRemote } = require("../out/generalized-workflow");
const { undoLastAction } = require("../out/undo-workflow");
const { GitRepository, GitError } = require("../out/git");
const { inspectRepositorySetup, inspectSetupLocalState, executeRepositorySetup } = require("../out/setup-workflow");
const { snapshotWorkingFiles, snapshotProject } = require("../out/project-snapshot");
const { startBranch, finishBranch, updateFromParent } = require("../out/lifecycle-workflow");
const { hostname } = require("os");
const { commandLockPath, acquireRepositoryCommandLock, recoverStaleCommandLock, withRepositoryCommandLock, withRepositoryWorkflow } = require("../out/repository-safety");
const { recoverIncompleteOperation } = require("../out/recovery-workflow");
const { reconcileWithRemote } = require("../out/conflict-workflow");

async function preservePatchAndStatus() {
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("output");
    commitFile(directory, "deleted.txt", "remove this file\n");
    const before = await repo.hash("HEAD");
    const contents = {
      "main.txt": Buffer.from("last line with spaces   \t\n"),
      "no-newline.txt": Buffer.from("last line with spaces   \t"),
      "binary.dat": Buffer.from([0, 255, 128, 13, 10, 0, 42]),
      "legacy-encoding.txt": Buffer.from([65, 255, 128, 10]),
      "run.sh": Buffer.from("#!/bin/sh\nexit 0\n"),
    };
    for (const [name, bytes] of Object.entries(contents)) {
      fs.writeFileSync(path.join(directory, name), bytes);
    }
    fs.chmodSync(path.join(directory, "run.sh"), 0o755);
    fs.symlinkSync("main.txt", path.join(directory, "link.txt"));
    fs.unlinkSync(path.join(directory, "deleted.txt"));
    git(directory, ["add", "--all"]);
    git(directory, ["commit", "-m", "Exact content"]);
    const after = await repo.hash("HEAD");
    await repo.replaceWorkingFiles(before);
    git(directory, ["config", "apply.whitespace", "fix"]);
    await repo.restoreCommitChanges(before, after);
    for (const [name, bytes] of Object.entries(contents)) {
      assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes, name);
    }
    assert.equal(fs.existsSync(path.join(directory, "deleted.txt")), false);
    assert.equal(fs.readlinkSync(path.join(directory, "link.txt")), "main.txt");
    assert.ok(fs.statSync(path.join(directory, "run.sh")).mode & 0o111);
    await repo.verifyRestoredCommitChanges(before, after);
    assert.ok((await repo.statusPorcelain()).startsWith(" D deleted.txt\n M main.txt\n"));
  });
}

async function receiptMetadata() {
  await withFixture(async ({ clone }) => {
    const { repo } = await clone("receipts");
    const tip = await repo.hash("HEAD");
    const plan = createOperationPlan({
      command: "Receipt regression",
      checkpointRestoration: { before: tip, after: tip },
      remoteHead: { remote: "origin", before: null, after: "refs/remotes/origin/main" },
    });
    await beginOperation(repo, plan);
    assert.deepEqual((await readOperationReceipt(repo, plan.operationId)).plan, plan);
    assert.match(renderOperationPreview(plan), /Restore checkpoint files/);
    assert.match(renderOperationPreview(plan), /does not replay/);
  });
  for (const command of ["save", "setup"]) {
    await withFixture(async ({ clone }) => {
      const { directory, repo } = await clone(`receipt-owner-${command}`);
      if (command === "save") await initializeRepository(repo);
      fs.writeFileSync(path.join(directory, "checkpoint.txt"), "retained work\n");
      const unrelated = createOperationPlan({ command: "Unrelated receipt during publication" });
      const hooks = {
        beforeRemotePush: async () => {
          await beginOperation(repo, unrelated);
          throw new Error("injected publication refusal");
        },
      };
      const result = command === "save"
        ? await commitAndSave(repo, hooks)
        : await executeRepositorySetup(repo, await inspectRepositorySetup(repo), { kind: "local-work" }, hooks);
      assert.equal(result.published, false);
      assert.equal(result.checkpointCreated, true);
      assert.ok(result.operationId);
      assert.notEqual(result.operationId, unrelated.operationId, "the failure reports the operation that this command started");
      const ownReceipt = await readOperationReceipt(repo, result.operationId);
      assert.equal(ownReceipt.plan.command, command === "save" ? "Commit and Save" : "Initialize Repository");
      assert.equal(ownReceipt.phase, "after-local-refs");
      assert.equal((await readOperationReceipt(repo, unrelated.operationId)).status, "planned");
      assert.equal(fs.readFileSync(path.join(directory, "checkpoint.txt"), "utf8"), "retained work\n");
    });
  }
}

async function undoContentAndConfiguration() {
  await withFixture(async ({ clone, seed }) => {
    const { directory, repo } = await clone("undo-config");
    await initializeRepository(repo);
    await repo.replaceConfigValues("branch.topic.remote", ["old-one", "old-two"]);
    await repo.replaceConfigValues("branch.topic.merge", ["refs/heads/old"]);
    git(seed, ["switch", "-c", "topic"]);
    commitFile(seed, "topic.txt", "topic\n");
    git(seed, ["push", "origin", "topic"]);
    await getFromRemote(repo);
    assert.deepEqual(await repo.getConfigValues("branch.topic.remote"), ["origin"]);
    await undoLastAction(repo);
    assert.deepEqual(await repo.getConfigValues("branch.topic.remote"), ["old-one", "old-two"]);
    assert.deepEqual(await repo.getConfigValues("branch.topic.merge"), ["refs/heads/old"]);

    const bytes = Buffer.from([0, 255, 1, 10, 0]);
    fs.writeFileSync(path.join(directory, "binary.dat"), bytes);
    fs.writeFileSync(path.join(directory, "main.txt"), "spaces   \t\n");
    await commitAndSave(repo);
    await undoLastAction(repo);
    assert.deepEqual(fs.readFileSync(path.join(directory, "binary.dat")), bytes);
    assert.equal(fs.readFileSync(path.join(directory, "main.txt"), "utf8"), "spaces   \t\n");
  });
  for (const interruption of ["before-files", "after-files", "after-boundary"]) {
    await withFixture(async ({ clone }) => {
      const { directory, repo } = await clone("undo-failure");
      await initializeRepository(repo);
      const before = await repo.hash("HEAD");
      fs.writeFileSync(path.join(directory, "saved.txt"), "retained   \n");
      if (interruption === "after-boundary") {
        // Ensure Undo has a configuration check after restoring the files.
        await repo.replaceConfigValues("branch.main.merge", ["refs/heads/previous"]);
      }
      const saved = await commitAndSave(repo);
      assert.equal(saved.published, true, saved.message);
      if (interruption === "after-boundary") {
        const savedReceipt = await readOperationReceipt(repo, saved.operationId);
        assert.ok(savedReceipt.plan.configurationChanges.some(change => change.key === "branch.main.merge"));
      }
      const original = repo.restoreCommitChanges.bind(repo);
      if (interruption === "after-boundary") {
        let restored = false;
        const verify = repo.verifyRestoredCommitChanges.bind(repo);
        repo.verifyRestoredCommitChanges = async (...args) => {
          await verify(...args);
          restored = true;
        };
        const getConfigValues = repo.getConfigValues.bind(repo);
        repo.getConfigValues = async key => {
          if (restored) throw new Error("injected restoration interruption");
          return getConfigValues(key);
        };
      } else {
        repo.restoreCommitChanges = async (...args) => {
          if (interruption === "after-files") await original(...args);
          throw new Error("injected restoration interruption");
        };
      }
      await assert.rejects(() => undoLastAction(repo), /injected restoration/);
      const [receipt] = await inspectIncompleteOperations(repo);
      assert.equal(receipt.phase, interruption === "after-boundary" ? "after-checkpoint-restoration" : "before-checkpoint-restoration");
      assert.equal(receipt.plan.checkpointRestoration.before, before);
      assert.ok((await repo.listRefs("refs/wipstream/recovery/")).some(ref => ref.objectId === receipt.plan.checkpointRestoration.after));
      if (interruption !== "before-files") assert.equal(fs.readFileSync(path.join(directory, "saved.txt"), "utf8"), "retained   \n");
    });
  }
}

async function initializeWithoutRemoteHead() {
  for (const kind of ["local-work", "remote", "legacy"]) {
    await withFixture(async ({ seed }) => {
      const repo = await GitRepository.open(seed);
      assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), undefined);
      if (kind === "legacy") await initializeRepository(repo);
      else {
        const inspection = await inspectRepositorySetup(repo);
        const choice = kind === "remote" ? { kind, backup: { kind: "discard", confirmed: true } } : { kind };
        const result = await executeRepositorySetup(repo, inspection, choice);
        assert.equal(result.kind, "completed", result.message);
      }
      assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), "refs/remotes/origin/main");
      if (kind !== "remote") {
        await undoLastAction(repo);
        assert.equal(await repo.symbolicRef("refs/remotes/origin/HEAD"), undefined);
        await initializeRepository(repo);
      }
      await getFromRemote(repo);
      fs.writeFileSync(path.join(seed, "saved.txt"), "saved\n");
      assert.equal((await commitAndSave(repo)).published, true);
      await startBranch(repo, "feature");
      fs.writeFileSync(path.join(seed, "feature.txt"), "feature\n");
      await finishBranch(repo, { chooseDisposition: async () => "delete" });
      assert.equal(await repo.currentBranch(), "main");
    });
  }
  await withFixture(async ({ clone, seed }) => {
    git(seed, ["switch", "-c", "topic"]);
    commitFile(seed, "topic.txt", "topic\n");
    git(seed, ["push", "origin", "topic"]);
    const { repo } = await clone("deleted-both");
    await initializeRepository(repo);
    const tip = await repo.hash(repo.localRef("topic"));
    await repo.updateRefs([{ ref: repo.localRef("topic"), expectedOld: tip, proposed: null }]);
    await repo.pushRefsAtomic("origin", [{ ref: repo.localRef("topic"), expected: tip, proposed: null }]);
    assert.equal((await commitAndSave(repo)).published, true);
  });
}

async function lifecycleIdentityAndMetadata() {
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("update-deleted");
    await initializeRepository(repo);
    await startBranch(repo, "parent");
    await commitAndSave(repo);
    await startBranch(repo, "child");
    await commitAndSave(repo);
    const child = await repo.hash(repo.localRef("child"));
    const publisher = await clone("delete-publisher");
    await publisher.repo.pushRefsAtomic("origin", [{ ref: repo.localRef("child"), expected: child, proposed: null }]);
    const parentBefore = await repo.hash(repo.localRef("parent"));
    await assert.rejects(() => updateFromParent(repo), error => error.code === "UPDATE_CHECKOUT_CHANGED");
    assert.equal(await repo.currentBranch(), "parent");
    assert.equal(await repo.hash(repo.localRef("parent")), parentBefore);

    await repo.replaceConfigValues("branch.parent.description", ["description one", "description two"]);
    await repo.replaceConfigValues("branch.parent.extra", ["  custom\ncontinued  ", ""]);
    await repo.replaceConfigValues("branch.parent-other.description", ["keep"]);
    fs.writeFileSync(path.join(directory, "parent.txt"), "parent\n");
    await finishBranch(repo, { chooseDisposition: async () => "delete" });
    assert.deepEqual(await repo.branchConfigurationKeys("parent"), []);
    assert.deepEqual(await repo.getConfigValues("branch.parent-other.description"), ["keep"]);
    await undoLastAction(repo);
    assert.deepEqual(await repo.getConfigValues("branch.parent.description"), ["description one", "description two"]);
    assert.deepEqual(await repo.getConfigValues("branch.parent.extra"), ["  custom\ncontinued  ", ""]);
  });
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("update-no-conflicts");
    await initializeRepository(repo);
    await startBranch(repo, "topic");
    commitFile(directory, "topic.txt", "topic\n");
    await commitAndSave(repo);
    await repo.switch("main");
    commitFile(directory, "parent.txt", "parent\n");
    await commitAndSave(repo);
    await repo.switch("topic");
    repo.merge = async target => {
      await repo.run(["merge", "--no-commit", "--no-ff", target]);
      throw new GitError(["merge", target], "injected commit failure", 1);
    };
    const result = await updateFromParent(repo);
    assert.equal(result.pending, true);
    assert.deepEqual(result.conflicts, []);
  });
  await withFixture(async ({ clone }) => {
    const { repo } = await clone("update-checkout-race");
    await initializeRepository(repo);
    await startBranch(repo, "topic");
    await commitAndSave(repo);
    const lockPath = await commandLockPath(repo);
    const currentBranch = repo.currentBranch.bind(repo);
    let injected = false;
    repo.currentBranch = async () => {
      if (!injected && fs.existsSync(lockPath) && JSON.parse(fs.readFileSync(lockPath, "utf8")).command === "Update from Parent") {
        injected = true;
        await repo.switch("main");
      }
      return currentBranch();
    };
    await assert.rejects(() => updateFromParent(repo), error => error.code === "UPDATE_CHECKOUT_CHANGED");
    assert.equal(injected, true);
    assert.equal(await repo.currentBranch(), "main");
    assert.deepEqual(await inspectIncompleteOperations(repo), []);
  });
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("reconcile-no-conflicts");
    await initializeRepository(repo);
    commitFile(directory, "local.txt", "local\n");
    const publisher = await clone("reconcile-publisher");
    commitFile(publisher.directory, "remote.txt", "remote\n");
    await publisher.repo.pushRefsAtomic("origin", [{
      ref: "refs/heads/main",
      expected: await repo.hash("refs/remotes/origin/main"),
      proposed: await publisher.repo.hash("HEAD"),
    }]);
    repo.merge = async target => {
      await repo.run(["merge", "--no-commit", "--no-ff", target]);
      throw new GitError(["merge", target], "injected commit failure", 1);
    };
    const result = await reconcileWithRemote(repo);
    assert.equal(result.pending, true);
    assert.deepEqual(result.conflicts, []);
  });
}

const cases = {
  output: preservePatchAndStatus,
  receipts: receiptMetadata,
  undo: undoContentAndConfiguration,
  initialize: initializeWithoutRemoteHead,
  lifecycle: lifecycleIdentityAndMetadata,
  recovery: recoverLocksAndRefusals,
  inspection: inspectSemanticIndexAndWorkingFiles,
};

async function inspectSemanticIndexAndWorkingFiles() {
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("index-refresh");
    const before = await inspectSetupLocalState(repo);
    const indexPath = path.join(directory, ".git", "index");
    const bytesBefore = fs.readFileSync(indexPath);
    const filename = path.join(directory, "main.txt");
    const stat = fs.statSync(filename);
    fs.utimesSync(filename, stat.atime, new Date(stat.mtimeMs + 10000));
    git(directory, ["update-index", "--refresh"]);
    assert.notDeepEqual(fs.readFileSync(indexPath), bytesBefore, "the stat-cache refresh really rewrote the index");
    assert.deepEqual(await inspectSetupLocalState(repo), before, "a stat-cache refresh leaves semantic approval unchanged");
    git(directory, ["update-index", "--assume-unchanged", "main.txt"]);
    assert.notEqual((await inspectSetupLocalState(repo)).index, before.index);
    git(directory, ["update-index", "--no-assume-unchanged", "main.txt"]);
    git(directory, ["update-index", "--skip-worktree", "main.txt"]);
    assert.notEqual((await inspectSetupLocalState(repo)).index, before.index);
    git(directory, ["update-index", "--no-skip-worktree", "main.txt"]);
    fs.writeFileSync(filename, "really changed\n");
    git(directory, ["add", "main.txt"]);
    assert.notEqual((await inspectSetupLocalState(repo)).index, before.index);
    const odd = "name with a newline\nand flags: text.txt";
    fs.writeFileSync(path.join(directory, odd), "intent\n");
    git(directory, ["add", "--intent-to-add", "--", odd]);
    const intent = (await inspectSetupLocalState(repo)).index;
    git(directory, ["add", "--", odd]);
    assert.notEqual((await inspectSetupLocalState(repo)).index, intent, "intent-to-add is distinct from ordinary staging");
  });
  await withFixture(async ({ clone }) => {
    const { directory, repo } = await clone("ignored-scan");
    fs.writeFileSync(path.join(directory, ".gitignore"), "cache/\n.DS_Store\n");
    fs.mkdirSync(path.join(directory, "cache"));
    for (let i = 0; i < 300; i += 1) fs.writeFileSync(path.join(directory, "cache", `${i}.dat`), Buffer.alloc(32768, i % 256));
    const snapshot = await snapshotWorkingFiles(repo);
    assert.equal(snapshot.filesRead, 2);
    assert.equal(snapshot.bytesRead, fs.statSync(path.join(directory, "main.txt")).size + fs.statSync(path.join(directory, ".gitignore")).size);
    const approved = await inspectRepositorySetup(repo);
    fs.writeFileSync(path.join(directory, "cache", "0.dat"), "watcher activity\n");
    fs.writeFileSync(path.join(directory, ".DS_Store"), "metadata\n");
    assert.equal((await inspectSetupLocalState(repo)).files, approved.local.files);
    const server = require("net").createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path.join(directory, "cache", "socket"), resolve);
    });
    try {
      assert.equal((await snapshotWorkingFiles(repo)).fingerprint, snapshot.fingerprint);
      await assert.rejects(() => snapshotProject(directory), error => error.code === "UNSUPPORTED_PROJECT_FILE");
      const result = await executeRepositorySetup(repo, approved, { kind: "local-work" });
      assert.equal(result.kind, "completed", result.message);
      assert.equal(fs.readFileSync(path.join(directory, "cache", "0.dat"), "utf8"), "watcher activity\n");
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function recoverLocksAndRefusals() {
  await withFixture(async ({ clone }) => {
    const { repo } = await clone("get-refusal");
    await initializeRepository(repo);
    const before = await repo.hash("HEAD");
    const listRefs = repo.listRefs.bind(repo);
    repo.listRefs = async prefix => {
      const refs = await listRefs(prefix);
      const ownPlan = (await inspectIncompleteOperations(repo)).find(receipt => receipt.plan.command === "Get from Remote" && receipt.phase === "planned");
      if (prefix === "refs/remotes/origin/" && ownPlan) {
        return refs.map(ref => ({ ...ref, objectId: "0".repeat(40) }));
      }
      return refs;
    };
    await assert.rejects(() => getFromRemote(repo), error => error.code === "REMOTE_TRACKING_CHANGED");
    repo.listRefs = listRefs;
    assert.equal(await repo.hash("HEAD"), before);
    assert.equal(await repo.statusPorcelain(), "");
    assert.deepEqual(await inspectIncompleteOperations(repo), []);
    const { listOperationReceipts } = require("../out/operations");
    const refused = (await listOperationReceipts(repo)).find(receipt => receipt.plan.command === "Get from Remote");
    assert.equal(refused.status, "aborted");
  });
  await withFixture(async ({ clone }) => {
    const { repo } = await clone("lock-recovery");
    const live = await acquireRepositoryCommandLock(repo, "live command");
    await assert.rejects(() => recoverStaleCommandLock(repo), error => error.code === "COMMAND_IN_PROGRESS");
    await live.release();
    const lockPath = await commandLockPath(repo);
    const stale = {
      schemaVersion: 1, operationId: "stale-test", command: "interrupted",
      pid: 2147483647, hostname: hostname(), startedAt: "2000-01-01T00:00:00.000Z", repositoryRoot: repo.root,
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    const outcomes = await Promise.allSettled([recoverStaleCommandLock(repo), recoverStaleCommandLock(repo)]);
    assert.ok(outcomes.some(result => result.status === "fulfilled" && result.value === true));
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(await repo.objectId("refs/wipstream/command-lock-recovery"), undefined);
    const next = await acquireRepositoryCommandLock(repo, "next command");
    await next.release();
    fs.writeFileSync(lockPath, JSON.stringify({ ...stale, hostname: "other-host" }));
    await assert.rejects(() => recoverStaleCommandLock(repo));
    assert.ok(fs.existsSync(lockPath));
    fs.writeFileSync(lockPath, "invalid lock");
    await assert.rejects(() => recoverStaleCommandLock(repo), error => error.code === "STALE_COMMAND_LOCK");
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    const lease = await repo.createBlob(JSON.stringify(stale));
    await repo.updateRefs([{ ref: "refs/wipstream/command-lock-recovery", expectedOld: null, proposed: lease }]);
    await recoverStaleCommandLock(repo);
    assert.equal(await repo.objectId("refs/wipstream/command-lock-recovery"), undefined);

    const plan = createOperationPlan({ command: "No-effect refusal" });
    const unrelated = createOperationPlan({ command: "Unrelated interrupted operation" });
    await assert.rejects(() => withRepositoryWorkflow(repo, "No-effect refusal", () => withRecordedOperation(repo, plan, async () => {
      await beginOperation(repo, unrelated);
      throw new Error("injected refusal");
    })), /injected refusal/);
    assert.equal((await readOperationReceipt(repo, plan.operationId)).status, "aborted");
    assert.equal((await readOperationReceipt(repo, unrelated.operationId)).status, "planned");
    await recoverIncompleteOperation(repo, unrelated.operationId);
    const previous = createOperationPlan({ command: "Already interrupted" });
    await beginOperation(repo, previous);
    await withRepositoryCommandLock(repo, "Inspect only", async () => {});
    assert.equal((await readOperationReceipt(repo, previous.operationId)).status, "planned");
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    await recoverIncompleteOperation(repo, previous.operationId);
    assert.equal((await readOperationReceipt(repo, previous.operationId)).status, "recovered");
  });
}

async function run() {
  const selected = process.argv.slice(2);
  for (const name of selected.length ? selected : Object.keys(cases)) {
    assert.ok(cases[name], `Unknown review regression group: ${name}`);
    await cases[name]();
    console.log(`WipStream review regression group passed: ${name}`);
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
