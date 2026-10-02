const assert = require("assert/strict");
const Module = require("module");
const fs = require("fs/promises");
const { readFileSync } = require("fs");
const path = require("path");
const { withFixture, git } = require("./setup-fixture");
const { repositoryState } = require("./fixture-state");
const operations = require("../out/operations");

function isolatedReceiptReader(receiptPath, input) {
  const modulePath = require.resolve("../out/operations");
  const cached = require.cache[modulePath];
  const originalLoad = Module._load;
  let reads = 0;
  delete require.cache[modulePath];
  Module._load = function(request, parent, isMain) {
    if (request === "fs/promises" && parent?.filename === modulePath) {
      return { ...fs, readFile: async (...args) => {
        if (args[0] !== receiptPath) return fs.readFile(...args);
        reads++;
        if (input instanceof Error) throw input;
        return input;
      } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const reader = require(modulePath);
    return { reader, reads: () => reads };
  } finally {
    Module._load = originalLoad;
    require.cache[modulePath] = cached;
  }
}

async function run() {
  await withFixture(async ({ clone, remote }) => {
    const { repo } = await clone("worker");
    const plan = operations.createOperationPlan({ command: "Receipt reader fixture" });
    const valid = await operations.beginOperation(repo, plan);
    const receiptPath = await operations.operationReceiptPath(repo, plan.operationId);
    const persisted = readFileSync(receiptPath, "utf8");
    const before = await repositoryState(repo, remote);
    const tip = await repo.hash("HEAD");
    const goodUpdates = [
      { ref: "refs/heads/new-topic", expectedOld: null, proposed: tip },
      { ref: "refs/heads/topic/slash", expectedOld: tip, proposed: "a".repeat(40) },
      { ref: "refs/heads/deleted-topic", expectedOld: tip, proposed: null },
      { ref: "refs/heads/unchanged-topic", expectedOld: tip, proposed: tip },
      { ref: "refs/wipstream/recovery/snapshot/0000", expectedOld: null, proposed: "b".repeat(64) },
    ];
    for (const update of goodUpdates) git(repo.root, ["check-ref-format", update.ref]);
    for (const ref of ["refs/tags/release@1", "refs/heads/café", "refs/heads/topic./child", "refs/heads/-leading", "refs/heads/name]", "refs/heads/name.LOCK"]) {
      git(repo.root, ["check-ref-format", ref]);
      goodUpdates.push({ ref, expectedOld: null, proposed: tip });
    }
    for (const version of [1, 2]) {
      for (const updates of [[], goodUpdates]) {
        const compatiblePlan = { ...plan, schemaVersion: version, localRefUpdates: updates };
        if (version === 1) compatiblePlan.remoteLeases = [];
        for (const includeOutcome of [false, true]) {
          const input = { ...valid, plan: compatiblePlan };
          if (includeOutcome) input.outcome = { additionalLocalRefUpdates: updates };
          const positive = isolatedReceiptReader(receiptPath, JSON.stringify(input));
          const receipt = await positive.reader.readOperationReceipt(repo, plan.operationId);
          assert.equal(receipt.plan.schemaVersion, 2);
          assert.deepEqual(receipt.plan.localRefUpdates, updates);
          if (includeOutcome) assert.deepEqual(receipt.outcome.additionalLocalRefUpdates, updates);
          assert.equal(positive.reads(), 1);
        }
      }
    }
    const missing = Object.assign(new Error("missing receipt"), { code: "ENOENT" });
    const unreadable = Object.assign(new Error("read failure"), { code: "EIO" });
    const malformed = [
      "{invalid-json",
      "null",
      JSON.stringify({ ...valid, schemaVersion: 999 }),
      JSON.stringify({ ...valid, status: "unknown" }),
      JSON.stringify({ ...valid, events: null }),
      JSON.stringify({ ...valid, plan: { ...plan, operationId: "different-operation" } }),
      JSON.stringify({ ...valid, plan: { ...plan, localRefUpdates: null } }),
      missing,
      unreadable,
    ];
    const positive = isolatedReceiptReader(receiptPath, persisted);
    assert.deepEqual(await positive.reader.readOperationReceipt(repo, plan.operationId), valid);
    assert.equal(positive.reads(), 1);
    const update = { ref: "refs/heads/topic", expectedOld: tip, proposed: "a".repeat(40) };
    const invalidUpdates = [
      { name: "non-array", updates: null },
      { name: "null-entry", updates: [null] },
      { name: "string-entry", updates: ["update"] },
      { name: "missing-fields", updates: [{}] },
      { name: "duplicate-ref", updates: [update, update] },
      { name: "both-null", updates: [{ ...update, expectedOld: null, proposed: null }] },
      { name: "original-reproducer", updates: [{ ref: "not-a-ref", expectedOld: null, proposed: "not-an-object-id" }] },
    ];
    const invalidRefs = [
      undefined, null, 7, "", "HEAD", "heads/main", "refs/heads/",
      "refs//heads/topic", "refs/heads/.hidden", "refs/heads/topic.lock",
      "refs/heads/topic.lock/child", "refs/heads/a..b", "refs/heads/topic.",
      "refs/heads/a@{b", "refs/heads/a b", "refs/heads/a\tb", "refs/heads/a\nb",
      "refs/heads/a\0b", "refs/heads/a\x7fb", "refs/heads/a~b", "refs/heads/a^b",
      "refs/heads/a:b", "refs/heads/a?b", "refs/heads/a*b", "refs/heads/a[b", "refs/heads/a\\b",
    ];
    for (const [index, ref] of invalidRefs.entries()) {
      if (typeof ref === "string" && ref.startsWith("refs/") && !ref.includes("\0")) {
        assert.throws(() => git(repo.root, ["check-ref-format", ref]), `Git also rejects ref fixture ${index}`);
      }
      invalidUpdates.push({ name: `invalid-ref-${index}`, updates: [{ ...update, ref }] });
    }
    const invalidObjectIds = [undefined, "", "tip", tip.slice(0, 12), "g".repeat(40), "a".repeat(41), "a".repeat(48), "a".repeat(65), 7, {}, []];
    for (const field of ["expectedOld", "proposed"]) {
      for (const [index, objectId] of invalidObjectIds.entries()) {
        invalidUpdates.push({ name: `invalid-${field}-${index}`, updates: [{ ...update, [field]: objectId }] });
      }
    }
    // Every bad entry is checked in both places Undo reads local updates.
    for (const candidate of invalidUpdates) {
      for (const location of ["plan", "outcome"]) {
        const input = location === "plan"
          ? { ...valid, plan: { ...plan, localRefUpdates: candidate.updates } }
          : { ...valid, outcome: { additionalLocalRefUpdates: candidate.updates } };
        const { reader, reads } = isolatedReceiptReader(receiptPath, JSON.stringify(input));
        await assert.rejects(() => reader.readOperationReceipt(repo, plan.operationId),
          error => error.code === "INVALID_OPERATION_RECEIPT" && error.message.includes(receiptPath),
          `${location}: ${candidate.name}`);
        assert.equal(reads(), 1);
        await assert.rejects(() => reader.inspectIncompleteOperations(repo), error => error.code === "INVALID_OPERATION_RECEIPT");
        assert.equal(reads(), 2);
      }
    }
    for (const outcome of [null, "outcome", {}]) {
      malformed.push(JSON.stringify({ ...valid, outcome }));
    }
    for (const input of malformed) {
      const { reader, reads } = isolatedReceiptReader(receiptPath, input);
      await assert.rejects(() => reader.readOperationReceipt(repo, plan.operationId), error => error.code === "INVALID_OPERATION_RECEIPT"
        && error.message.includes(receiptPath));
      assert.equal(reads(), 1, "the bad input reaches the actual receipt reader");
      await assert.rejects(() => reader.inspectIncompleteOperations(repo), error => error.code === "INVALID_OPERATION_RECEIPT");
      assert.equal(reads(), 2, "inventory refuses an unreadable receipt rather than hiding an incomplete operation");
      assert.equal(readFileSync(receiptPath, "utf8"), persisted, "no persisted receipt is edited");
      assert.deepEqual(await repositoryState(repo, remote), before);
    }
    assert.deepEqual(await operations.readOperationReceipt(repo, plan.operationId), valid);
    assert.equal(readFileSync(receiptPath, "utf8"), persisted);
    assert.deepEqual(await repositoryState(repo, remote), before);
    assert.equal(path.basename(receiptPath), `${plan.operationId}.json`);
  });
  console.log("WipStream receipt reader positive and negative fixtures passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
