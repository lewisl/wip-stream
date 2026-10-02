const assert = require("assert/strict");
const Module = require("module");
const path = require("path");
const realGit = require("../out/git");

class Emitter {
  listeners = new Set();
  event = callback => {
    this.listeners.add(callback);
    return { dispose: () => this.listeners.delete(callback) };
  };
  fire(value) { for (const callback of this.listeners) callback(value); }
}

const gitChange = new Emitter();
const opened = new Emitter();
const closed = new Emitter();
const editor = new Emitter();
const folders = new Emitter();
const focus = new Emitter();
const gitRepo = { state: { onDidChange: gitChange.event } };
const contexts = new Map();
const commands = [];
const handlers = new Map();
let branch = "feature";
let pending;
let undoEligible = true;
let selectedRoot;
let repositoryChoices;
const notifications = [];
const inspectedRoots = [];
const incompleteByRoot = new Map();
const firstRoot = path.resolve("/fixture");
const secondRoot = path.resolve("/another-fixture");
const repo = {
  root: firstRoot,
  currentBranch: async () => branch,
  localRef: name => `refs/heads/${name}`,
  remoteTrackingRef: (remote, name) => `refs/remotes/${remote}/${name}`,
  refExists: async () => true,
  relation: async () => "equal",
  branchExists: async () => true,
  isAncestor: async () => true,
  withNetworkCancellation(signal) { return { ...this, selectedSignal: signal }; },
};
const otherRepo = { ...repo, root: secondRoot };
const vscode = {
  Disposable: class { constructor(dispose) { this.dispose = dispose; } },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    onDidChangeActiveTextEditor: editor.event,
    onDidChangeWindowState: focus.event,
    showWarningMessage: async () => undefined,
    showQuickPick: async items => {
      repositoryChoices = items;
      return items.find(item => item.description === selectedRoot);
    },
    showInformationMessage: async message => { notifications.push({ kind: "information", message }); },
    showErrorMessage: async message => { notifications.push({ kind: "error", message }); },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/fixture" } }],
    onDidChangeWorkspaceFolders: folders.event,
  },
  commands: { registerCommand: (name, handler) => {
    handlers.set(name, handler);
    return { dispose() {} };
  }, executeCommand: async (name, key, value) => {
    if (name === "setContext") contexts.set(key, value);
    else commands.push(name);
  } },
  extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => ({
    repositories: [gitRepo], onDidOpenRepository: opened.event, onDidCloseRepository: closed.event,
  }) }) }) },
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "vscode") return vscode;
  if (parent?.filename === path.resolve(__dirname, "../out/commands.js")) {
    if (request === "./git") return { ...realGit, GitRepository: { open: async candidate => {
      const resolved = path.resolve(candidate);
      if (resolved === secondRoot) return otherRepo;
      if (resolved === firstRoot || resolved.startsWith(firstRoot + path.sep)) return repo;
      throw new Error("Not a repository");
    } } };
    if (request === "./operations") return { inspectIncompleteOperations: async selected => {
      inspectedRoots.push(selected.root);
      return incompleteByRoot.get(selected.root) || [];
    } };
    if (request === "./conflict-workflow") return { inspectPendingMerge: async () => pending };
    if (request === "./undo-workflow") return { inspectUndoEligibility: async () => ({ eligible: undoEligible }) };
    if (request === "./repository-model") return {
      readRepositoryConfiguration: async () => ({ kind: "initialized", remote: "origin" }),
      resolveRemoteTrackingDefaultBranch: async () => "main",
      getBranchParent: async () => "main",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { reportSave, selectRepository, handleCommandError } = require("../out/commands");
const { activate } = require("../out/extension");
Module._load = originalLoad;

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
}

async function run() {
  const context = { subscriptions: [] };
  activate(context);
  await settle();
  assert.equal(handlers.size, 12);
  assert.deepEqual(commands, [], "startup activates without invoking a WipStream command");
  assert.equal(contexts.get("wipstream.undoAvailable"), true);
  assert.equal(contexts.get("wipstream.condenseAvailable"), true);
  assert.equal(contexts.size, 2, "only manifest context consumers are calculated");
  branch = "main";
  gitChange.fire();
  await settle();
  assert.equal(contexts.get("wipstream.condenseAvailable"), false, "external checkout refreshes context");
  branch = "feature";
  pending = { operationId: "external-merge" };
  gitChange.fire();
  await settle();
  assert.equal(contexts.get("wipstream.undoAvailable"), false);
  assert.equal(contexts.get("wipstream.condenseAvailable"), false);
  pending = undefined;
  focus.fire({ focused: true });
  await settle();
  assert.equal(contexts.get("wipstream.undoAvailable"), true);
  assert.equal(contexts.get("wipstream.condenseAvailable"), true);
  closed.fire(gitRepo);
  await settle();
  assert.equal(gitChange.listeners.size, 0);
  opened.fire(gitRepo);
  await settle();
  assert.equal(gitChange.listeners.size, 1);

  // Active-editor and workspace candidates for the same root are deduplicated.
  vscode.workspace.workspaceFolders = [firstRoot, secondRoot].map(fsPath => ({ uri: { fsPath } }));
  vscode.window.activeTextEditor = { document: { uri: { scheme: "file", fsPath: path.join(firstRoot, "sub", "file.txt") } } };
  selectedRoot = secondRoot;
  assert.equal(await selectRepository(), otherRepo);
  assert.deepEqual(repositoryChoices.map(choice => choice.description), [firstRoot, secondRoot]);
  const controller = new AbortController();
  const selectedWithSignal = await selectRepository(controller.signal);
  assert.equal(selectedWithSignal.root, secondRoot);
  assert.equal(selectedWithSignal.selectedSignal, controller.signal);
  selectedRoot = undefined;
  await assert.rejects(() => selectRepository(), error => error.code === "CANCELLED");
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: firstRoot } }];
  assert.equal((await selectRepository(controller.signal)).selectedSignal, controller.signal);
  incompleteByRoot.set(firstRoot, [{ plan: { operationId: "first-operation" } }]);
  const cancellation = new realGit.GitError(["fetch"], "cancelled", undefined, undefined, true);
  const outputLines = [];
  const errorOutput = { appendLine: line => outputLines.push(line), show() {} };
  await handleCommandError(errorOutput, "Get from Remote", cancellation);
  assert.deepEqual(inspectedRoots, [firstRoot]);
  assert.equal(notifications.at(-1).kind, "error");
  assert.match(notifications.at(-1).message, /first-operation/);
  vscode.workspace.workspaceFolders = [firstRoot, secondRoot].map(fsPath => ({ uri: { fsPath } }));
  selectedRoot = secondRoot;
  await selectRepository();
  incompleteByRoot.set(secondRoot, [{ plan: { operationId: "second-operation" } }]);
  await handleCommandError(errorOutput, "Get from Remote", cancellation);
  assert.deepEqual(inspectedRoots, [firstRoot, secondRoot]);
  assert.match(notifications.at(-1).message, /second-operation/);
  assert.doesNotMatch(notifications.at(-1).message, /first-operation/);
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: firstRoot } }];

  // Clearing the cached repository must not inspect or attribute a receipt
  // from the previously selected repository to a later command.
  folders.fire();
  await settle();
  await handleCommandError(errorOutput, "Commit and Save", cancellation);
  assert.deepEqual(inspectedRoots, [firstRoot, secondRoot]);
  assert.equal(notifications.at(-1).kind, "information");
  assert.match(notifications.at(-1).message, /Commit and Save was cancelled before an operation began/);
  assert.doesNotMatch(outputLines.at(-1), /first-operation|second-operation/);
  const ordinaryError = new Error("backend failed");
  await handleCommandError(errorOutput, "Start Branch", ordinaryError);
  assert.equal(notifications.at(-1).kind, "error");
  assert.match(notifications.at(-1).message, /backend failed/);
  vscode.workspace.workspaceFolders = [];
  vscode.window.activeTextEditor = undefined;
  await assert.rejects(() => selectRepository(), error => error.code === "NO_REPOSITORY");
  for (const subscription of context.subscriptions) subscription.dispose();
  assert.equal(gitChange.listeners.size, 0);
  assert.equal(editor.listeners.size, 0);
  assert.equal(folders.listeners.size, 0);
  assert.equal(focus.listeners.size, 0);
  const output = { appendLine() {}, show() {} };
  await reportSave(output, { published: false, message: "Network unavailable", advisories: [] });
  assert.deepEqual(commands, [], "dismissing a failed save must not trigger an unoffered Reconcile action");
}

run().then(() => console.log("WipStream external Git context refresh tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
