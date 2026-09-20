const assert = require("assert/strict");
const Module = require("module");

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
let branch = "feature";
let pending;
const repo = {
  root: "/fixture",
  currentBranch: async () => branch,
  localRef: name => `refs/heads/${name}`,
  remoteTrackingRef: (remote, name) => `refs/remotes/${remote}/${name}`,
  refExists: async () => true,
  relation: async () => "equal",
  branchExists: async () => true,
  isAncestor: async () => true,
};
const vscode = {
  Disposable: class { constructor(dispose) { this.dispose = dispose; } },
  window: {
    onDidChangeActiveTextEditor: editor.event,
    onDidChangeWindowState: focus.event,
    showWarningMessage: async () => undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/fixture" } }],
    onDidChangeWorkspaceFolders: folders.event,
  },
  commands: { executeCommand: async (name, key, value) => {
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
  if (parent?.filename.endsWith("/out/commands.js")) {
    if (request === "./git") return { GitRepository: { open: async () => repo } };
    if (request === "./conflict-workflow") return { inspectPendingMerge: async () => pending };
    if (request === "./undo-workflow") return { inspectUndoEligibility: async () => ({ eligible: false }) };
    if (request === "./repository-model") return {
      readRepositoryConfiguration: async () => ({ kind: "initialized", remote: "origin" }),
      resolveRemoteTrackingDefaultBranch: async () => "main",
      getBranchParent: async () => "main",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { registerContextRefresh, reportSave } = require("../out/commands");
Module._load = originalLoad;

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
}

async function run() {
  const context = { subscriptions: [] };
  registerContextRefresh(context);
  await settle();
  assert.equal(contexts.get("wipstream.finishAvailable"), true);
  branch = "main";
  gitChange.fire();
  await settle();
  assert.equal(contexts.get("wipstream.finishAvailable"), false, "external checkout refreshes context");
  branch = "feature";
  pending = { operationId: "external-merge" };
  gitChange.fire();
  await settle();
  assert.equal(contexts.get("wipstream.pendingMerge"), true);
  assert.equal(contexts.get("wipstream.finishAvailable"), false);
  pending = undefined;
  focus.fire({ focused: true });
  await settle();
  assert.equal(contexts.get("wipstream.pendingMerge"), false);
  assert.equal(contexts.get("wipstream.finishAvailable"), true);
  closed.fire(gitRepo);
  await settle();
  assert.equal(gitChange.listeners.size, 0);
  opened.fire(gitRepo);
  await settle();
  assert.equal(gitChange.listeners.size, 1);
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
