const assert = require("assert/strict");
const Module = require("module");
const path = require("path");

const handlers = new Map();
const repo = {
  root: path.resolve("/fixture/project"),
  operationInProgress: async () => scenario.activeMerge,
  currentBranch: async () => "feature",
  hash: async () => "current-head",
  conflictPaths: async () => [],
  statusPorcelain: async () => "",
};
const saveHooks = { saveDocuments: async () => {} };
const parentSelector = async () => "main";
let scenario;

function reset(overrides = {}) {
  scenario = {
    calls: [], output: [], errors: [], successes: [], reports: [], pendingReports: [],
    warnings: [], dialogs: [], values: [], prompts: [], receipts: [], refreshed: 0,
    disposed: 0, activeMerge: true, selectionError: undefined, cancelNetwork: false,
    eligibility: { eligible: true, operationId: "completed-op", command: "Commit and Save" },
    pending: { operationId: "merge-op", command: "Reconcile with Remote", branch: "feature" },
    ...overrides,
  };
}

function record(name, args) {
  scenario.calls.push({ name, args });
  if (scenario.failure) throw scenario.failure;
}

const saved = { published: true, operationId: "save-op", message: "Saved", advisories: [] };
const workflows = {
  "./generalized-workflow": {
    getFromRemote: async (...args) => {
      record("get", args);
      return { operationId: "get-op", checkout: "feature", created: ["topic"], fastForwarded: [], deleted: [], updated: true, advisories: [] };
    },
    commitAndSave: async (...args) => { record("save", args); return saved; },
  },
  "./lifecycle-workflow": {
    startBranch: async (...args) => { record("start", args); return { branch: args[1], parent: "main", operationId: "start-op" }; },
    updateFromParent: async (...args) => {
      record("update", args);
      return { branch: "feature", parent: "main", updated: true, pending: scenario.pendingResult, conflicts: ["shared.txt"], operationId: "update-op" };
    },
    condenseBranch: async (...args) => {
      record("condense", args);
      const options = args[1];
      assert.equal(options.selectParent, parentSelector);
      const accepted = await options.confirmPreview({ branch: "feature", parent: "main", exclusiveCommits: 3 });
      if (!accepted) throw Object.assign(new Error("Condense cancelled"), { code: "CANCELLED" });
      const message = await options.requestMessage("Condense feature");
      assert.equal(message, "Intentional feature commit");
      scenario.condensed = true;
      return { operationId: "condense-op", branch: "feature", parent: "main", exclusiveCommits: 3, oldTip: "old", newTip: "new" };
    },
  },
  "./conflict-workflow": {
    inspectPendingMerge: async () => scenario.pending,
    reconcileWithRemote: async (...args) => {
      record("reconcile", args);
      return { pending: scenario.pendingResult, conflicts: ["shared.txt"], operationId: "reconcile-op", branch: "feature", save: saved };
    },
    continuePendingMerge: async (...args) => {
      record("continue", args);
      return { operationId: "merge-op", command: "Reconcile with Remote", save: saved };
    },
    abortPendingMerge: async (...args) => {
      record("abort", args);
      return { operationId: "merge-op", command: "Reconcile with Remote", restored: true };
    },
  },
  "./undo-workflow": {
    inspectUndoEligibility: async () => scenario.eligibility,
    undoLastAction: async (...args) => {
      record("undo", args);
      return { operationId: "undo-op", undoneOperationId: "completed-op", command: "Commit and Save", restoredCheckout: "feature" };
    },
  },
  "./operations": {
    inspectIncompleteOperations: async selected => { assert.equal(selected, repo); return scenario.receipts; },
    renderOperationPreview: plan => `Preview ${plan.operationId}`,
  },
  "./repository-safety": { recoverStaleCommandLock: async () => false },
  "./recovery-workflow": {
    recoverIncompleteOperation: async (...args) => {
      record("recover", args);
      return scenario.receipts.find(receipt => receipt.plan.operationId === args[1]);
    },
  },
};

const helpers = {
  selectRepository: async signal => {
    if (scenario.selectionError) throw scenario.selectionError;
    assert.ok(signal instanceof AbortSignal);
    scenario.signal = signal;
    return repo;
  },
  assertNoDirtyDocuments: selected => { assert.equal(selected, repo); scenario.dirtyChecked = true; },
  saveHooks: selected => { assert.equal(selected, repo); return saveHooks; },
  selectParent: parentSelector,
  saveRepositoryDocuments: async selected => {
    assert.equal(selected, repo);
    scenario.documentsSaved = true;
    scenario.calls.push({ name: "save-documents", args: [selected] });
  },
  askValue: async (...args) => { scenario.prompts.push(args); return scenario.values.shift(); },
  runFinish: async (...args) => record("finish", args),
  branchList: branches => branches.join(", "),
  appendAdvisories: (_output, advisories) => { scenario.advisories = advisories; },
  showSuccess: (_output, ...args) => scenario.successes.push(args),
  reportSave: async (_output, result) => scenario.reports.push(result),
  notifyPendingMerge: async (_output, ...args) => scenario.pendingReports.push(args),
  handleCommandError: async (_output, title, error) => scenario.errors.push({ title, error }),
  refreshActiveCommandContexts: async () => { scenario.refreshed++; },
  registerContextRefresh() {},
};
const output = { appendLine: line => scenario.output.push(line), show() {}, dispose() {} };
const vscode = {
  ProgressLocation: { Notification: 1 },
  commands: { registerCommand: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; } },
  window: {
    createOutputChannel: () => output,
    withProgress: async (options, action) => {
      scenario.progress = options;
      return action({}, { onCancellationRequested: callback => {
        if (scenario.cancelNetwork) callback();
        return { dispose: () => { scenario.disposed++; } };
      } });
    },
    showWarningMessage: async (message, options, ...buttons) => {
      scenario.dialogs.push({ message, options, buttons });
      const choice = scenario.warnings.shift();
      return buttons.includes(choice) ? choice : undefined;
    },
    showQuickPick: async items => items.find(item => item.receipt?.plan.operationId === scenario.selectedOperation),
  },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (parent?.filename === path.resolve(__dirname, "../out/registered-commands.js")) {
    if (request === "./commands") return helpers;
    if (workflows[request]) return workflows[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};
let registerCommands;
try {
  ({ registerCommands } = require("../out/registered-commands"));
} finally {
  Module._load = originalLoad;
}

async function invoke(name) {
  await handlers.get(`wipstream.${name}`)();
  assert.equal(scenario.refreshed, 1, "completion, cancellation, and failures all refresh contexts");
  assert.equal(scenario.disposed, 1, "the cancellation subscription is disposed");
}

async function ordinaryHandlers() {
  for (const [command, workflow] of [["resume", "get"], ["saveup", "save"], ["start", "start"], ["finish", "finish"], ["update", "update"], ["reconcile", "reconcile"], ["continue", "continue"]]) {
    reset({ values: ["new-topic"] });
    await invoke(command);
    assert.deepEqual(scenario.errors, []);
    const call = scenario.calls.find(item => item.name === workflow);
    assert.ok(call, `${command} invokes ${workflow}`);
    assert.equal(call.args[workflow === "finish" ? 1 : 0], repo);
    if (command === "start") assert.equal(call.args[1], "new-topic");
    if (["saveup", "reconcile", "continue"].includes(command)) assert.equal(call.args[1], saveHooks);
    if (command === "update") assert.equal(call.args[1], parentSelector);
    if (["resume", "update", "reconcile"].includes(command)) assert.equal(scenario.dirtyChecked, true);
    if (["saveup", "reconcile", "continue"].includes(command)) assert.deepEqual(scenario.reports, [saved]);
    if (command === "continue") assert.deepEqual(scenario.calls.map(item => item.name), ["save-documents", "continue"]);
    if (["resume", "start", "update"].includes(command)) assert.ok(scenario.successes[0][2].endsWith("-op"));
    if (["reconcile", "continue"].includes(command)) assert.match(scenario.output.join("\n"), /SUCCESS.*operation=(reconcile|merge)-op/);
  }
  for (const command of ["update", "reconcile"]) {
    reset({ pendingResult: true });
    await invoke(command);
    assert.deepEqual(scenario.pendingReports, [[command === "update" ? "Update from Parent" : "Reconcile with Remote", `${command}-op`, ["shared.txt"]]]);
    assert.deepEqual(scenario.successes, []);
    assert.deepEqual(scenario.reports, []);
    assert.doesNotMatch(scenario.output.join("\n"), /SUCCESS/);
  }
}

async function confirmations() {
  for (const [command, button, workflow] of [["abort", "Abort Merge", "abort"], ["undo", "Undo Action", "undo"], ["condense", "Condense Branch", "condense"]]) {
    for (const choice of [button, "Cancel", undefined]) {
      reset({ warnings: [choice], values: ["Intentional feature commit"] });
      await invoke(command);
      assert.equal(scenario.dialogs.length, 1);
      assert.equal(scenario.dialogs[0].options.modal, true);
      assert.deepEqual(scenario.dialogs[0].buttons, [button]);
      if (choice === button) {
        assert.deepEqual(scenario.errors, []);
        assert.equal(scenario.calls.filter(call => call.name === workflow).length, 1);
        assert.equal(scenario.successes.length, 1);
        if (command === "condense") {
          assert.equal(scenario.condensed, true);
          assert.deepEqual(scenario.prompts, [["Condensed commit message", "Condense feature"]]);
        }
      } else {
        assert.equal(scenario.errors[0].error.code, "CANCELLED");
        assert.deepEqual(scenario.successes, []);
        if (command === "condense") {
          assert.equal(scenario.condensed, undefined);
          assert.deepEqual(scenario.prompts, []);
        } else assert.deepEqual(scenario.calls, []);
      }
    }
  }
  for (const [command, overrides, code] of [
    ["abort", { pending: undefined }, "NO_PENDING_MERGE"],
    ["undo", { eligibility: { eligible: false, reason: "Later work exists" } }, "UNDO_NOT_ELIGIBLE"],
  ]) {
    reset(overrides);
    await invoke(command);
    assert.equal(scenario.errors[0].error.code, code);
    assert.deepEqual(scenario.dialogs, []);
    assert.deepEqual(scenario.calls, []);
  }
}

async function recoverySelection() {
  const receipts = ["first", "second"].map(id => ({ plan: { operationId: id, command: "Finish Branch" }, phase: "before-checkout" }));
  reset({ receipts, selectedOperation: "second", activeMerge: false, warnings: ["Keep Current State"] });
  await invoke("recover");
  assert.deepEqual(scenario.calls, [{ name: "recover", args: [repo, "second"] }]);
  assert.equal(scenario.successes[0][2], "second");
  assert.match(scenario.dialogs[0].options.detail, /Operation: second/);
  assert.match(scenario.output.join("\n"), /Preview second/);
  reset({ receipts, selectedOperation: undefined, activeMerge: false });
  await invoke("recover");
  assert.deepEqual(scenario.calls, []);
  assert.deepEqual(scenario.dialogs, []);
}

async function progressAndErrors() {
  for (const command of ["init", "resume", "saveup", "start", "finish", "update", "reconcile", "continue", "abort", "recover", "undo", "condense"]) {
    const failure = new Error("repository selection failed");
    reset({ selectionError: failure });
    await invoke(command);
    assert.equal(scenario.progress.cancellable, !["start", "abort", "recover"].includes(command));
    assert.equal(scenario.errors[0].error, failure);
    assert.deepEqual(scenario.calls, []);
  }
  reset({ cancelNetwork: true });
  await invoke("resume");
  assert.equal(scenario.signal.aborted, true, "the cancellation signal reaches repository selection");
  const failure = Object.assign(new Error("publication refused"), { code: "REMOTE_CHANGED" });
  reset({ failure });
  await invoke("saveup");
  assert.equal(scenario.errors[0].error, failure);
  assert.deepEqual(scenario.reports, []);
  assert.doesNotMatch(scenario.output.join("\n"), /SUCCESS/);
}

async function run() {
  reset();
  registerCommands({ subscriptions: [] });
  assert.deepEqual([...handlers.keys()].sort(), require("../package.json").contributes.commands.map(item => item.command).sort());
  await ordinaryHandlers();
  await confirmations();
  await recoverySelection();
  await progressAndErrors();
  console.log("WipStream registered command behavior tests passed.");
}

run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
