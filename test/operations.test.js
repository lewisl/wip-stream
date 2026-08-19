const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

const { GitError, GitRepository } = require("../out/git");
const {
  OperationError,
  applyLocalRefTransaction,
  beginOperation,
  completeOperation,
  createOperationPlan,
  inspectIncompleteOperations,
  listOperationReceipts,
  localTransactionUpdates,
  operationReceiptPath,
  pruneCompletedReceipts,
  readOperationReceipt,
  recordOperationPhase,
  recoveryRef,
  renderOperationPreview,
  withMutationBoundary,
} = require("../out/operations");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createRepository(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init"]);
  git(root, ["config", "user.name", "WipStream Operation Test"]);
  git(root, ["config", "user.email", "wipstream-operation@example.invalid"]);
  writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "Baseline"]);
  git(root, ["branch", "-M", "main"]);
  return root;
}

async function withRepository(prefix, action) {
  const root = createRepository(prefix);
  try {
    await action(root, await GitRepository.open(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function commitTree(directory, parent, message) {
  const tree = git(directory, ["rev-parse", `${parent}^{tree}`]);
  return git(directory, ["commit-tree", tree, "-p", parent, "-m", message]);
}

function ref(directory, name) {
  return git(directory, ["rev-parse", name]);
}

function refExists(directory, name) {
  try {
    git(directory, ["rev-parse", "--verify", name]);
    return true;
  } catch {
    return false;
  }
}

async function expectOperationError(action, code) {
  try {
    await action();
    assert.fail(`Expected operation error ${code}`);
  } catch (error) {
    assert.ok(error instanceof OperationError, `Expected OperationError, got ${error}`);
    assert.equal(error.code, code);
  }
}

function repositoryState(directory) {
  return {
    refs: git(directory, ["show-ref"]),
    config: git(directory, ["config", "--local", "--list"]),
    status: git(directory, ["status", "--porcelain=v1"]),
    file: readFileSync(path.join(directory, "tracked.txt"), "utf8"),
  };
}

async function runPlanAndPreviewContract() {
  await withRepository("wipstream-operation-preview-", async (directory, repo) => {
    const old = ref(directory, "main");
    const next = commitTree(directory, old, "Next");
    const plan = createOperationPlan({
      operationId: "preview-operation",
      command: "Preview Test",
      localRefUpdates: [{ ref: "refs/heads/topic/with/slashes", expectedOld: old, proposed: next }],
      remoteRefUpdates: [{ ref: "refs/heads/topic/with/slashes", proposed: next }],
      remoteLeases: [{ ref: "refs/heads/topic/with/slashes", expected: old }],
      checkpoint: { branch: "main", before: old, after: next, message: "Checkpoint preview" },
      checkout: { before: "main", after: "topic/with/slashes" },
      destructiveEffects: [{
        kind: "rewrite-local-ref",
        ref: "refs/heads/topic/with/slashes",
        description: "Replace the local topic tip",
      }],
    });
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.localRefUpdates));
    assert.ok(Object.isFrozen(plan.localRefUpdates[0]));
    assert.ok(Object.isFrozen(plan.checkpoint));
    assert.equal(recoveryRef(plan.operationId, 0), "refs/wipstream/recovery/preview-operation/0000");
    assert.equal(localTransactionUpdates(plan)[0].ref, recoveryRef(plan.operationId, 0));

    const before = repositoryState(directory);
    const preview = renderOperationPreview(plan);
    assert.match(preview, /topic\/with\/slashes/);
    assert.match(preview, /lease/);
    assert.match(preview, /Checkpoint preview/);
    assert.match(preview, /Recovery snapshots: 1/);
    assert.deepEqual(repositoryState(directory), before, "preview rendering is side-effect free");
    assert.equal(refExists(directory, recoveryRef(plan.operationId, 0)), false);
    assert.ok((await operationReceiptPath(repo, plan.operationId)).startsWith(await repo.commonGitDirectory()));

    await expectOperationError(
      () => Promise.resolve(createOperationPlan({ operationId: "unsafe/operation", command: "Invalid" })),
      "INVALID_OPERATION_ID"
    );
  });
}

async function runExpectedOldTransactionContract() {
  await withRepository("wipstream-operation-transaction-", async (directory, repo) => {
    const old = ref(directory, "main");
    const nextA = commitTree(directory, old, "Next A");
    const nextB = commitTree(directory, old, "Next B");
    git(directory, ["branch", "topic/with/slashes", old]);
    git(directory, ["branch", "second", old]);

    const mismatch = createOperationPlan({
      operationId: "mismatch-operation",
      command: "Mismatched transaction",
      localRefUpdates: [
        { ref: "refs/heads/topic/with/slashes", expectedOld: old, proposed: nextA },
        { ref: "refs/heads/second", expectedOld: nextA, proposed: nextB },
      ],
    });
    await beginOperation(repo, mismatch);
    await assert.rejects(() => applyLocalRefTransaction(repo, mismatch), (error) => error instanceof GitError);
    assert.equal(ref(directory, "topic/with/slashes"), old);
    assert.equal(ref(directory, "second"), old);
    assert.equal(refExists(directory, recoveryRef(mismatch.operationId, 0)), false);
    assert.equal(refExists(directory, recoveryRef(mismatch.operationId, 1)), false);
    const mismatchReceipt = await readOperationReceipt(repo, mismatch.operationId);
    assert.equal(mismatchReceipt.phase, "before-local-refs");
    assert.equal(mismatchReceipt.status, "in-progress");

    const success = createOperationPlan({
      operationId: "successful-operation",
      command: "Successful transaction",
      localRefUpdates: [
        { ref: "refs/heads/topic/with/slashes", expectedOld: old, proposed: nextA },
        { ref: "refs/heads/second", expectedOld: old, proposed: nextB },
      ],
    });
    await beginOperation(repo, success);
    await applyLocalRefTransaction(repo, success);
    assert.equal(ref(directory, "topic/with/slashes"), nextA);
    assert.equal(ref(directory, "second"), nextB);
    assert.equal(ref(directory, recoveryRef(success.operationId, 0)), old);
    assert.equal(ref(directory, recoveryRef(success.operationId, 1)), old);
    const successReceipt = await readOperationReceipt(repo, success.operationId);
    assert.deepEqual(successReceipt.events.map(({ phase }) => phase), ["planned", "before-local-refs", "after-local-refs"]);

    git(directory, ["branch", "doomed", old]);
    const createAndDelete = createOperationPlan({
      operationId: "create-delete-operation",
      command: "Create and delete transaction",
      localRefUpdates: [
        { ref: "refs/heads/new-branch", expectedOld: null, proposed: nextA },
        { ref: "refs/heads/doomed", expectedOld: old, proposed: null },
      ],
    });
    await beginOperation(repo, createAndDelete);
    await applyLocalRefTransaction(repo, createAndDelete);
    assert.equal(ref(directory, "new-branch"), nextA);
    assert.equal(refExists(directory, "doomed"), false);
    assert.equal(refExists(directory, recoveryRef(createAndDelete.operationId, 0)), false);
    assert.equal(ref(directory, recoveryRef(createAndDelete.operationId, 1)), old);
  });
}

async function runInterruptionContract() {
  await withRepository("wipstream-operation-interruption-", async (directory, repo) => {
    const old = ref(directory, "main");
    const next = commitTree(directory, old, "Interrupted next");
    git(directory, ["branch", "interrupted", old]);
    const plan = createOperationPlan({
      operationId: "interrupted-operation",
      command: "Interrupted transaction",
      localRefUpdates: [{ ref: "refs/heads/interrupted", expectedOld: old, proposed: next }],
    });

    await beginOperation(repo, plan);
    assert.equal(ref(directory, "interrupted"), old, "planned interruption retains the before-state");
    await assert.rejects(
      () => withMutationBoundary(repo, plan.operationId, "local-refs", async () => {
        await repo.updateRefs(localTransactionUpdates(plan));
        throw new Error("simulated process interruption after the ref transaction");
      }),
      /simulated process interruption/
    );
    assert.equal(ref(directory, "interrupted"), next, "an atomic transaction establishes the complete after-state");
    assert.equal(ref(directory, recoveryRef(plan.operationId, 0)), old);
    const interrupted = await readOperationReceipt(repo, plan.operationId);
    assert.equal(interrupted.phase, "before-local-refs");
    assert.equal(interrupted.status, "in-progress");
    assert.deepEqual(interrupted.plan, plan, "the incomplete receipt retains the complete immutable plan");
    assert.ok((await inspectIncompleteOperations(repo)).some((receipt) => receipt.plan.operationId === plan.operationId));
  });
}

async function runRetentionContract() {
  await withRepository("wipstream-operation-retention-", async (_directory, repo) => {
    const incomplete = createOperationPlan({ operationId: "retain-incomplete", command: "Incomplete" });
    await beginOperation(repo, incomplete);
    for (const operationId of ["completed-one", "completed-two", "completed-three"]) {
      const plan = createOperationPlan({ operationId, command: operationId });
      await beginOperation(repo, plan);
      await completeOperation(repo, operationId, 2);
    }
    await pruneCompletedReceipts(repo, 2);
    const receipts = await listOperationReceipts(repo);
    assert.equal(receipts.filter(({ status }) => status === "completed").length, 2);
    assert.deepEqual(
      (await inspectIncompleteOperations(repo)).map(({ plan }) => plan.operationId),
      [incomplete.operationId],
      "completed-receipt retention never removes incomplete operations"
    );
  });
}

async function runBoundaryJournalContract() {
  await withRepository("wipstream-operation-boundaries-", async (_directory, repo) => {
    const plan = createOperationPlan({ operationId: "all-boundaries", command: "All boundaries" });
    await beginOperation(repo, plan);
    for (const boundary of ["remote-push", "remote-fetch", "local-refs", "checkout", "configuration"]) {
      await withMutationBoundary(repo, plan.operationId, boundary, async () => undefined);
    }
    await completeOperation(repo, plan.operationId);
    const receipt = await readOperationReceipt(repo, plan.operationId);
    assert.deepEqual(receipt.events.map(({ phase }) => phase), [
      "planned",
      "before-remote-push",
      "after-remote-push",
      "before-remote-fetch",
      "after-remote-fetch",
      "before-local-refs",
      "after-local-refs",
      "before-checkout",
      "after-checkout",
      "before-configuration",
      "after-configuration",
      "completed",
    ]);
    assert.equal(receipt.status, "completed");
    assert.equal((await inspectIncompleteOperations(repo)).length, 0);
    await expectOperationError(
      () => recordOperationPhase(repo, plan.operationId, "before-local-refs"),
      "OPERATION_ALREADY_COMPLETED"
    );

    const invalid = createOperationPlan({ operationId: "invalid-phase", command: "Invalid phase" });
    await beginOperation(repo, invalid);
    await expectOperationError(
      () => recordOperationPhase(repo, invalid.operationId, "after-local-refs"),
      "INVALID_OPERATION_PHASE"
    );
  });
}

Promise.resolve()
  .then(runPlanAndPreviewContract)
  .then(runExpectedOldTransactionContract)
  .then(runInterruptionContract)
  .then(runRetentionContract)
  .then(runBoundaryJournalContract)
  .then(() => console.log("WipStream operation transaction tests passed."))
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
