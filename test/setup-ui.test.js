const assert = require("assert/strict");
const Module = require("module");
const path = require("path");

const labels = {
  remote: "Use the remote’s version",
  local: "Commit this machine’s work and save to remote",
  reconcile: "Resolve differences locally, then save to remote",
};
const repo = {
  root: path.resolve("/fixture/project"),
  currentBranch: async () => "main",
  hash: async () => "current-head",
  operationInProgress: async () => false,
  conflictPaths: async () => [],
  statusPorcelain: async () => " M tracked.txt",
};
const backupPath = path.resolve("/fixture/backups/project-backup-timestamp");
let scenario;

function inspection(requiresChoice = true) {
  return {
    repositoryRoot: repo.root,
    remote: "origin",
    remoteDefaultBranch: "main",
    requiresChoice,
    local: {
      checkout: requiresChoice ? "feature" : "main",
      status: requiresChoice ? " M tracked.txt" : "",
      editors: { dirty: requiresChoice },
    },
    branches: requiresChoice ? [
      { name: "main", relation: "remote-ahead", localTip: "old", fetchedRemoteTip: "new" },
      { name: "feature", relation: "diverged", localTip: "local", fetchedRemoteTip: "remote" },
      { name: "local-only", relation: "local-only", localTip: "local-only" },
    ] : [{ name: "main", relation: "equal", localTip: "same", fetchedRemoteTip: "same" }],
    reconciliationBranches: requiresChoice ? ["feature"] : [],
  };
}

function completed(overrides = {}) {
  return {
    kind: "completed", operationId: "setup-op", checkpointCreated: false,
    published: true, publishedBranches: [], checkout: "main",
    created: [], fastForwarded: [], deleted: [], ...overrides,
  };
}

function reset(overrides = {}) {
  scenario = {
    quick: [], warning: [], folder: [], information: [],
    inspections: [inspection()], results: [completed()],
    dialogs: [], executions: [], events: [], output: [], opened: [], errors: [],
    editors: { signature: "editor-before", dirty: true },
    controller: new AbortController(), configuration: { kind: "uninitialized" },
    recoveries: [], receipts: [], progressStarted: 0, progressFinished: 0,
    ...overrides,
  };
  return scenario;
}

async function answer(kind, message, options, items) {
  // Model VS Code's built-in modal Cancel, which the old mock omitted.
  const visibleButtons = options?.modal ? [...items, "Cancel"] : undefined;
  scenario.dialogs.push({ kind, message, options, items, visibleButtons });
  const response = scenario[kind].shift();
  const result = typeof response === "function" ? await response({ message, options, items }) : response;
  return kind === "warning" && options?.modal && result === "Cancel" ? undefined : result;
}

const vscode = {
  Uri: { file: fsPath => ({ scheme: "file", fsPath }) },
  ProgressLocation: { Notification: 1 },
  workspace: { textDocuments: [] },
  window: {
    showQuickPick: async (items, options) => {
      const selected = await answer("quick", undefined, options, items);
      return items.find(item => item.label === selected);
    },
    showWarningMessage: async (message, ...args) => {
      const options = typeof args[0] === "object" ? args.shift() : undefined;
      return answer("warning", message, options, args);
    },
    showInformationMessage: async (message, ...items) => answer("information", message, undefined, items),
    showOpenDialog: async options => answer("folder", undefined, options, []),
    createOutputChannel: () => output,
    withProgress: async (_options, callback) => {
      scenario.progressStarted++;
      try {
        return await callback({}, {
          onCancellationRequested: () => ({ dispose() {} }),
        });
      } finally {
        scenario.progressFinished++;
      }
    },
  },
  commands: {
    executeCommand: async (...args) => {
      if (scenario.openFolderError) throw scenario.openFolderError;
      scenario.opened.push(args);
    },
    registerCommand: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; },
  },
};
const output = {
  appendLine: line => scenario.output.push(line), show() {}, dispose() {},
};
const handlers = new Map();
const commandHelpers = {
  branchList: branches => branches.length ? branches.join(", ") : "none",
  readRepositoryEditorState: () => scenario.editors,
  saveHooks: () => ({ saveDocuments: async () => scenario.events.push("save-documents") }),
  selectRepository: async () => { scenario.events.push("select-repository"); return repo; },
  askValue: async () => { scenario.events.push("ask-remote"); return "origin"; },
  saveRepositoryDocuments: async () => { throw new Error("Initialize must not save before inspection/choice"); },
  refreshActiveCommandContexts: async () => scenario.events.push("refresh-contexts"),
  registerContextRefresh() {},
  handleCommandError: async (_output, _title, error) => scenario.errors.push(error),
};
const setupWorkflow = {
  inspectRepositorySetup: async (_repo, requestedRemote, hooks) => {
    scenario.events.push("inspect");
    scenario.inspectionHooks = hooks;
    scenario.requestedRemote = requestedRemote;
    assert.equal(hooks.readEditorState(), scenario.editors);
    return scenario.inspections.shift();
  },
  executeRepositorySetup: async (_repo, approved, choice, hooks) => {
    scenario.events.push("execute");
    scenario.executions.push({ approved, choice, hooks });
    if (choice.kind !== "reconcile") await hooks.saveDocuments();
    const result = scenario.results.shift();
    return typeof result === "function" ? result(choice, hooks) : result;
  },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (parent?.filename.endsWith("/out/setup-ui.js")) {
    if (request === "./commands") return commandHelpers;
    if (request === "./setup-workflow") return setupWorkflow;
  }
  if (parent?.filename.endsWith("/out/registered-commands.js")) {
    if (request === "./commands") return commandHelpers;
    if (request === "./repository-model") return { readRepositoryConfiguration: async () => scenario.configuration };
    if (request === "./operations") return {
      inspectIncompleteOperations: async () => scenario.receipts,
      renderOperationPreview: plan => `Preview: ${plan.command}`,
    };
    if (request === "./recovery-workflow") return {
      recoverIncompleteOperation: async (_repo, id) => {
        scenario.recoveries.push(id);
        return scenario.receipts.find(receipt => receipt.plan.operationId === id);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { runRepositorySetup, reportSetupRecovery } = require("../out/setup-ui");
const { registerCommands } = require("../out/registered-commands");
const { readRepositoryEditorState, saveRepositoryDocuments } = require("../out/commands");
Module._load = originalLoad;

function settleNotificationActions() {
  return new Promise(setImmediate);
}

async function runSetup() {
  await runRepositorySetup(output, repo, "origin", scenario.controller.signal);
  await settleNotificationActions();
}

function assertNoSetupSuccess() {
  assert.doesNotMatch(scenario.output.join("\n"), /SUCCESS  Initialize Repository/);
  assert.ok(scenario.dialogs.every(dialog => !dialog.items?.includes("Undo Last Action")), "no setup result offers misleading Undo");
}

async function testChoices() {
  reset({ quick: [labels.local], results: [completed({ checkpointCreated: true, publishedBranches: ["feature"] })] });
  await runSetup();
  assert.deepEqual(scenario.events, ["inspect", "execute", "save-documents"]);
  assert.equal(scenario.executions[0].choice.kind, "local-work");
  assert.equal(scenario.executions[0].hooks.signal, scenario.controller.signal);
  assert.equal(scenario.executions[0].hooks.readEditorState(), scenario.editors);
  const picker = scenario.dialogs.find(dialog => dialog.kind === "quick");
  assert.deepEqual(picker.items.map(item => item.label), [labels.remote, labels.local, labels.reconcile, "Cancel"]);
  assert.match(picker.options.placeHolder, /All ordinary branches/);
  assert.match(scenario.output.join("\n"), /feature: diverged/);
  assert.match(scenario.dialogs.at(-1).message, /checkpointed and saved to the remote/);

  reset({ inspections: [inspection(false)] });
  await runSetup();
  assert.equal(scenario.dialogs.filter(dialog => dialog.kind === "quick").length, 0, "matching clean setup needs no authority dialog");
  assert.equal(scenario.executions[0].choice.kind, "local-work");
  assert.match(scenario.output.join("\n"), /SUCCESS  Initialize Repository/);

  const reconcileMessage = "Your existing local work is retained. Nothing was published. Resolve differences on “feature” in your Git tool, incorporating the remote history. Matching file contents alone does not resolve divergent history. Then rerun Initialize Repository.";
  reset({ quick: [labels.reconcile], results: [{ kind: "reconciliation-required", checkpointCreated: false, published: false, branches: ["feature"], message: reconcileMessage }] });
  await runSetup();
  assert.deepEqual(scenario.events, ["inspect", "execute"], "external reconciliation does not save editor documents");
  assert.match(scenario.dialogs.at(-1).message, /feature.*Git tool.*remote history.*rerun Initialize/s);
  assertNoSetupSuccess();
}

async function testRemoteChoices() {
  reset({
    quick: [labels.remote], warning: ["Copy project, then use remote"],
    folder: [[vscode.Uri.file(path.resolve("/fixture/backups"))]],
    information: ["Open Backup Folder"],
    results: [completed({ published: false, backupPath, replaced: ["feature"], deleted: ["local-only"] })],
  });
  await runSetup();
  const picker = scenario.dialogs.find(dialog => dialog.kind === "folder");
  assert.equal(picker.options.defaultUri.fsPath, path.dirname(repo.root));
  assert.equal(picker.options.canSelectFiles, false);
  assert.equal(picker.options.canSelectFolders, true);
  assert.equal(picker.options.canSelectMany, false);
  assert.deepEqual(scenario.executions[0].choice, { kind: "remote", backup: { kind: "copy", parent: path.resolve("/fixture/backups") } });
  const confirmation = scenario.dialogs.find(dialog => dialog.kind === "warning");
  assert.equal(confirmation.options.modal, true);
  assert.equal(confirmation.visibleButtons.filter(button => button === "Cancel").length, 1, "backup dialog shows exactly one Cancel");
  assert.match(confirmation.options.detail, /ALL ordinary branches.*local-only.*non-ignored.*No push, merge, or content commit/s);
  assert.match(scenario.dialogs.at(-1).message, /Nothing was pushed.*no content commit/s);
  assert.ok(scenario.dialogs.at(-1).message.includes(backupPath), "full backup path is displayed");
  assert.match(scenario.output.join("\n"), /SUCCESS  Initialize Repository.*published=false/);
  assert.deepEqual(scenario.opened, [["vscode.openFolder", vscode.Uri.file(backupPath), true]]);

  reset({ quick: [labels.remote], warning: ["Use remote without a backup", "Discard Local Work and Use Remote"], results: [completed({ published: false })] });
  await runSetup();
  assert.deepEqual(scenario.executions[0].choice, { kind: "remote", backup: { kind: "discard", confirmed: true } });
  const warnings = scenario.dialogs.filter(dialog => dialog.kind === "warning");
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].options.modal, true);
  assert.equal(warnings[1].visibleButtons.filter(button => button === "Cancel").length, 1, "discard dialog shows exactly one Cancel");
  assert.match(warnings[1].options.detail, /No complete backup.*not be recoverable/s);
  assert.deepEqual(scenario.dialogs.at(-1).items, [], "no backup means no Open Backup Folder action");
  assert.deepEqual(scenario.opened, []);
}

async function testCancellations() {
  const cases = [
    { quick: [] },
    { quick: ["Cancel"] },
    { quick: [labels.remote], warning: [] },
    { quick: [labels.remote], warning: ["Cancel"] },
    { quick: [labels.remote], warning: ["Copy project, then use remote"], folder: [] },
    { quick: [labels.remote], warning: ["Copy project, then use remote"], folder: [[]] },
    { quick: [labels.remote], warning: ["Use remote without a backup"] },
    { quick: [labels.remote], warning: ["Use remote without a backup", "Cancel"] },
    { quick: [() => { scenario.controller.abort(); return labels.remote; }] },
    { quick: [labels.remote], warning: [() => { scenario.controller.abort(); return "Copy project, then use remote"; }] },
    { quick: [labels.remote], warning: ["Copy project, then use remote"], folder: [() => { scenario.controller.abort(); return [vscode.Uri.file("/fixture/backups")]; }] },
  ];
  for (const choices of cases) {
    reset(choices);
    await runSetup();
    assert.deepEqual(scenario.executions, [], "cancelled dialogs never authorize workflow execution");
    assert.equal(scenario.events.includes("save-documents"), false);
    assert.deepEqual(scenario.opened, []);
    assertNoSetupSuccess();
  }
  reset();
  scenario.controller.abort();
  await runSetup();
  assert.deepEqual(scenario.events, [], "already-cancelled progress does not inspect or fetch");
}

async function testIncompleteResults() {
  const cases = [
    { kind: "failed", checkpointCreated: true, published: false, message: "The checkpoint is saved locally. Nothing was published. Push rejected." },
    { kind: "reconciliation-required", checkpointCreated: true, published: false, branches: ["feature"], message: "The checkpoint is saved locally. Nothing was published. Resolve differences on feature in your Git tool, then rerun Initialize." },
    { kind: "cancelled", checkpointCreated: true, published: false, message: "The checkpoint is saved locally. Setup was cancelled; nothing was published." },
    { kind: "failed", checkpointCreated: false, published: false, operationId: "interrupted-adoption", backupPath, message: `Remote adoption did not complete. Backup retained at ${backupPath}. Run Recover Incomplete Operation.` },
    { kind: "failed", checkpointCreated: false, published: false, backupPath, message: `Backup is incomplete at ${backupPath}. No replacement began.` },
  ];
  for (const result of cases) {
    reset({ quick: [labels.local], results: [result] });
    await runSetup();
    assertNoSetupSuccess();
    assert.ok(scenario.dialogs.at(-1).message.includes(result.message));
    assert.deepEqual(scenario.opened, [], "backup is not opened unless requested");
    assert.deepEqual(scenario.dialogs.at(-1).items, result.backupPath ? ["Open Backup Folder"] : []);
  }
  reset({ quick: [labels.local], warning: ["Open Backup Folder"], results: [cases[3]] });
  await runSetup();
  assertNoSetupSuccess();
  assert.deepEqual(scenario.opened, [["vscode.openFolder", vscode.Uri.file(backupPath), true]]);
}

async function testFreshApproval() {
  const changed = { kind: "preview-required", checkpointCreated: false, published: false, message: "Editor documents were saved. Review the updated setup preview." };
  reset({
    inspections: [inspection(), inspection(false)],
    quick: [labels.remote, labels.local], warning: ["Use remote without a backup", "Discard Local Work and Use Remote", "Review Updated Setup"],
    results: [changed, completed()],
  });
  await runSetup();
  assert.equal(scenario.executions.length, 2);
  assert.equal(scenario.executions[0].choice.kind, "remote");
  assert.equal(scenario.executions[1].choice.kind, "local-work", "old discard approval is not reused");
  assert.equal(scenario.dialogs.filter(dialog => dialog.kind === "quick").length, 2, "even a fresh clean state requires a new choice after a stale preview");
  assert.deepEqual(scenario.events, ["inspect", "execute", "save-documents", "inspect", "execute", "save-documents"]);

  reset({ quick: [labels.local], results: [changed] });
  await runSetup();
  assert.equal(scenario.executions.length, 1, "dismissing stale preview does not retry");
  assertNoSetupSuccess();

  reset({
    inspections: [inspection(), inspection()], quick: [labels.local, "Cancel"], warning: ["Review Updated Setup"],
    results: [{ ...changed, checkpointCreated: true, message: "The checkpoint is saved locally. State changed." }],
  });
  await runSetup();
  assertNoSetupSuccess();
  assert.match(scenario.dialogs.at(-1).message, /checkpoint created earlier is saved locally/);

  reset({ quick: [labels.local], results: [() => { scenario.controller.abort(); return changed; }] });
  await runSetup();
  assertNoSetupSuccess();
  assert.ok(!scenario.dialogs.at(-1).items.includes("Review Updated Setup"), "aborted progress cannot restart a preview");
}

async function testEditorState() {
  const document = (filename, dirty, version = 1, scheme = "file") => ({
    uri: { fsPath: filename, scheme }, isDirty: dirty, version,
    save: async () => { scenario.events.push(`saved:${filename}`); return true; },
  });
  reset();
  const tracked = document(path.join(repo.root, "tracked.txt"), false);
  const ignored = document(path.join(repo.root, "ignored.txt"), true);
  vscode.workspace.textDocuments = [tracked, ignored, document("/outside/dirty.txt", true), document("Untitled-1", true, 1, "untitled")];
  const before = readRepositoryEditorState(repo);
  assert.equal(before.dirty, true);
  vscode.workspace.textDocuments.reverse();
  assert.equal(readRepositoryEditorState(repo).signature, before.signature, "signature is independent of document order");
  ignored.version++;
  assert.notEqual(readRepositoryEditorState(repo).signature, before.signature, "unsaved edits invalidate approval");
  await saveRepositoryDocuments(repo);
  assert.deepEqual(scenario.events, [`saved:${ignored.uri.fsPath}`], "only dirty file-backed repository documents are saved");
  ignored.isDirty = false;
  assert.equal(readRepositoryEditorState(repo).dirty, false);
  ignored.isDirty = true;
  ignored.save = async () => false;
  await assert.rejects(saveRepositoryDocuments(repo), error => error.code === "SAVE_FAILED");
  vscode.workspace.textDocuments = [];
}

async function testRegisteredCommandsAndRecovery() {
  reset();
  registerCommands({ subscriptions: [] });
  reset({ quick: ["Cancel"] });
  await handlers.get("wipstream.init")();
  assert.deepEqual(scenario.events, ["select-repository", "ask-remote", "inspect", "refresh-contexts"]);
  assert.deepEqual(scenario.errors, []);
  assertNoSetupSuccess();
  reset({ quick: ["Cancel"], configuration: { kind: "initialized", remote: "origin" } });
  await handlers.get("wipstream.init")();
  assert.ok(scenario.events.includes("inspect"), "copied initialized markers never bypass inspection");
  assert.ok(!scenario.events.includes("ask-remote"));

  const receipt = {
    plan: { operationId: "adoption-op", command: "Adopt Remote for Setup", remoteAdoption: { backup: { kind: "verified-copy", path: backupPath } } },
    phase: "file-replacement",
  };
  reset({ receipts: [receipt], warning: ["Keep Current State"], information: ["Open Backup Folder"] });
  await handlers.get("wipstream.recover")();
  await settleNotificationActions();
  assert.deepEqual(scenario.errors, []);
  assert.deepEqual(scenario.recoveries, ["adoption-op"]);
  assert.ok(scenario.dialogs[0].options.detail.includes(backupPath));
  assert.match(scenario.dialogs[0].options.detail, /Ref restoration cannot recover discarded uncommitted files/);
  assert.match(scenario.dialogs.at(-1).message, /No backup was restored.*no remote synchronization is claimed.*Initialize Repository/s);
  assert.deepEqual(scenario.opened, [["vscode.openFolder", vscode.Uri.file(backupPath), true]]);
  assertNoSetupSuccess();

  reset({ receipts: [receipt] });
  await handlers.get("wipstream.recover")();
  assert.deepEqual(scenario.recoveries, [], "dismissed recovery never closes the receipt");
  assert.deepEqual(scenario.opened, []);
  assert.doesNotMatch(scenario.output.join("\n"), /SUCCESS/);

  reset();
  await reportSetupRecovery(output, "without-backup");
  assert.deepEqual(scenario.dialogs.at(-1).items, []);
  assert.deepEqual(scenario.opened, []);
}

function deferredNotification() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function assertProgressFinishesBeforeNotification(commandId) {
  let finished = false;
  const running = handlers.get(commandId)().then(() => { finished = true; });
  await settleNotificationActions();
  assert.equal(finished, true, "a terminal notification must not keep command progress running");
  assert.equal(scenario.progressStarted, 1);
  assert.equal(scenario.progressFinished, 1);
  assert.deepEqual(scenario.errors, []);
  return running;
}

async function testPendingNotifications() {
  // Each notification intentionally stays open until after command completion.
  for (const choice of ["Cancel", undefined]) {
    const notification = deferredNotification();
    reset({ quick: [labels.remote], warning: [choice], information: [() => notification.promise] });
    try {
      await assertProgressFinishesBeforeNotification("wipstream.init");
      assert.deepEqual(scenario.executions, [], "modal cancellation does not run the workflow");
      assertNoSetupSuccess();
    } finally {
      notification.resolve(undefined);
      await settleNotificationActions();
    }
  }

  const notification = deferredNotification();
  reset({
    quick: [labels.remote], warning: ["Copy project, then use remote"],
    folder: [[vscode.Uri.file(path.resolve("/fixture/backups"))]],
    information: [() => notification.promise],
    results: [completed({ published: false, backupPath })],
  });
  try {
    await assertProgressFinishesBeforeNotification("wipstream.init");
    assert.match(scenario.output.join("\n"), /SUCCESS  Initialize Repository/);
    assert.deepEqual(scenario.opened, [], "completion does not open a backup automatically");
    notification.resolve("Open Backup Folder");
    await settleNotificationActions();
    assert.deepEqual(scenario.opened, [["vscode.openFolder", vscode.Uri.file(backupPath), true]], "backup action still works after progress closes");
  } finally {
    notification.resolve(undefined);
    await settleNotificationActions();
  }

  const resultCases = [
    { kind: "cancelled", checkpointCreated: true, published: false, message: "Checkpoint saved locally; setup cancelled." },
    { kind: "failed", checkpointCreated: true, published: false, message: "Checkpoint saved locally; nothing published." },
    { kind: "reconciliation-required", checkpointCreated: true, published: false, branches: ["feature"], message: "Checkpoint saved locally; reconcile feature externally." },
  ];
  for (const result of resultCases) {
    const pending = deferredNotification();
    const notificationKind = result.kind === "cancelled" ? "information" : "warning";
    reset({ quick: [labels.local], results: [result], [notificationKind]: [() => pending.promise] });
    try {
      await assertProgressFinishesBeforeNotification("wipstream.init");
      assertNoSetupSuccess();
      assert.match(scenario.dialogs.at(-1).message, /Checkpoint saved locally/);
    } finally {
      pending.resolve(undefined);
      await settleNotificationActions();
    }
  }

  const recovery = deferredNotification();
  reset({
    receipts: [{ plan: { operationId: "adoption-op", command: "Adopt Remote for Setup", remoteAdoption: { backup: { kind: "verified-copy", path: backupPath } } }, phase: "file-replacement" }],
    warning: ["Keep Current State"], information: [() => recovery.promise],
  });
  try {
    await assertProgressFinishesBeforeNotification("wipstream.recover");
    assert.deepEqual(scenario.recoveries, ["adoption-op"]);
  } finally {
    recovery.resolve(undefined);
    await settleNotificationActions();
  }

  const failedOpen = deferredNotification();
  const error = new Error("Cannot open backup window");
  reset({
    quick: [labels.local], results: [completed({ backupPath })],
    information: [() => failedOpen.promise], openFolderError: error,
  });
  try {
    await assertProgressFinishesBeforeNotification("wipstream.init");
    failedOpen.resolve("Open Backup Folder");
    await settleNotificationActions();
    assert.deepEqual(scenario.errors, [error], "errors from later backup actions are reported, not unhandled");
    assert.equal(scenario.progressFinished, 1);
  } finally {
    failedOpen.resolve(undefined);
    await settleNotificationActions();
  }
}

async function testPreviewStillRequiresDecision() {
  const review = deferredNotification();
  const completion = deferredNotification();
  reset({
    inspections: [inspection(), inspection(false)], quick: [labels.local, labels.local],
    results: [
      { kind: "preview-required", checkpointCreated: false, published: false, message: "State changed; review a fresh preview." },
      completed(),
    ],
    warning: [() => review.promise], information: [() => completion.promise],
  });
  let finished = false;
  const running = handlers.get("wipstream.init")().then(() => { finished = true; });
  try {
    await settleNotificationActions();
    assert.equal(finished, false, "a fresh-preview decision is still awaited");
    assert.equal(scenario.progressFinished, 0);
    assert.equal(scenario.executions.length, 1, "no execution continues without a review decision");
    assertNoSetupSuccess();
    review.resolve("Review Updated Setup");
    await settleNotificationActions();
    assert.equal(finished, true, "after fresh approval, completion does not wait for its notice");
    assert.equal(scenario.progressFinished, 1);
    assert.equal(scenario.executions.length, 2);
    assert.equal(scenario.dialogs.filter(dialog => dialog.kind === "quick").length, 2);
  } finally {
    review.resolve(undefined);
    completion.resolve(undefined);
    await running;
    await settleNotificationActions();
  }
}

async function run() {
  await testChoices();
  await testRemoteChoices();
  await testCancellations();
  await testIncompleteResults();
  await testFreshApproval();
  await testEditorState();
  await testRegisteredCommandsAndRecovery();
  await testPendingNotifications();
  await testPreviewStillRequiresDecision();
}

run().then(() => console.log("WipStream setup choices, dialogs, editor state, and recovery UI tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
