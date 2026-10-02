const assert = require("assert/strict");
const { readFileSync } = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const primary = [
  { id: "wipstream.init", title: "Initialize Repository" },
  { id: "wipstream.resume", title: "Get from Remote" },
  { id: "wipstream.saveup", title: "Commit and Save" },
];
const contextual = [
  ["wipstream.start", undefined],
  ["wipstream.finish", undefined],
  ["wipstream.update", undefined],
  ["wipstream.reconcile", undefined],
  ["wipstream.continue", undefined],
  ["wipstream.abort", undefined],
  ["wipstream.recover", undefined],
  ["wipstream.undo", "wipstream.undoAvailable"],
  ["wipstream.condense", "wipstream.condenseAvailable"],
];
const removedLegacy = ["wipstream.tofeature", "wipstream.tomain"];

const declared = new Map(packageJson.contributes.commands.map(({ command, title }) => [command, title]));
for (const { id, title } of primary) assert.equal(declared.get(id), title);
for (const [id] of contextual) assert.ok(declared.has(id), `${id} is declared`);
for (const id of removedLegacy) assert.equal(declared.has(id), false, `${id} is no longer declared`);

assert.deepEqual(
  packageJson.contributes.keybindings,
  [],
  "WipStream leaves platform shortcuts available for user bindings"
);
assert.ok(packageJson.activationEvents.includes("onStartupFinished"), "contextual commands become discoverable before any command is invoked");

const palette = new Map(packageJson.contributes.menus.commandPalette.map(({ command, when }) => [command, when]));
for (const [id, when] of contextual) {
  assert.ok(palette.has(id), `${id} is present in the command palette`);
  assert.equal(palette.get(id), when, `${id} has the intended visibility`);
}
for (const id of removedLegacy) assert.equal(palette.has(id), false, `${id} is absent from the command palette`);

for (const id of [...primary.map(({ id }) => id), ...contextual.map(([id]) => id)]) {
  assert.ok(packageJson.activationEvents.includes(`onCommand:${id}`), `${id} activates the extension`);
}
for (const id of removedLegacy) {
  assert.equal(packageJson.activationEvents.includes(`onCommand:${id}`), false, `${id} has no activation event`);
}

console.log("WipStream generalized VS Code command-surface tests passed.");
