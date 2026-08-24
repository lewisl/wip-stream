const assert = require("assert/strict");
const { readFileSync } = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const commandHelpersSource = readFileSync(path.join(root, "src", "commands.ts"), "utf8");
const registeredCommandsSource = readFileSync(path.join(root, "src", "registered-commands.ts"), "utf8");
const commandsSource = commandHelpersSource + registeredCommandsSource;

const primary = [
  { id: "wipstream.init", title: "Initialize Repository", key: "ctrl+w i" },
  { id: "wipstream.resume", title: "Get from Remote", key: "ctrl+w g" },
  { id: "wipstream.saveup", title: "Commit and Save", key: "ctrl+w s" },
];
const contextual = [
  ["wipstream.start", "wipstream.initialized"],
  ["wipstream.finish", "wipstream.finishAvailable"],
  ["wipstream.update", "wipstream.updateAvailable"],
  ["wipstream.reconcile", "wipstream.reconcileAvailable"],
  ["wipstream.continue", "wipstream.pendingMerge"],
  ["wipstream.abort", "wipstream.pendingMerge"],
  ["wipstream.undo", "wipstream.undoAvailable"],
  ["wipstream.condense", "wipstream.condenseAvailable"],
];
const removedLegacy = ["wipstream.tofeature", "wipstream.tomain"];
const cancellable = ["init", "resume", "saveup", "finish", "update", "reconcile", "continue", "undo", "condense"];
const localOnly = ["start", "abort"];

const declared = new Map(packageJson.contributes.commands.map(({ command, title }) => [command, title]));
for (const { id, title } of primary) assert.equal(declared.get(id), title);
for (const [id] of contextual) assert.ok(declared.has(id), `${id} is declared`);
for (const id of removedLegacy) assert.equal(declared.has(id), false, `${id} is no longer declared`);

assert.deepEqual(
  packageJson.contributes.keybindings,
  primary.map(({ id, key }) => ({ command: id, key })),
  "normal use retains only the three primary chords"
);

const palette = new Map(packageJson.contributes.menus.commandPalette.map(({ command, when }) => [command, when]));
for (const [id, when] of contextual) assert.equal(palette.get(id), when, `${id} has contextual visibility`);
for (const id of removedLegacy) assert.equal(palette.has(id), false, `${id} is absent from the command palette`);

for (const id of [...primary.map(({ id }) => id), ...contextual.map(([id]) => id)]) {
  assert.ok(packageJson.activationEvents.includes(`onCommand:${id}`), `${id} activates the extension`);
  assert.ok(
    registeredCommandsSource.includes(`registerCommand(context, output, "${id.replace("wipstream.", "")}"`),
    `${id} has a registered handler`
  );
}
for (const id of removedLegacy) {
  assert.equal(packageJson.activationEvents.includes(`onCommand:${id}`), false, `${id} has no activation event`);
  assert.equal(
    registeredCommandsSource.includes(`registerCommand(context, output, "${id.replace("wipstream.", "")}"`),
    false,
    `${id} has no handler`
  );
}

assert.match(commandsSource, /operation=\$\{operationId\}/, "Output records include operation ids");
assert.doesNotMatch(commandsSource, /confirmMigrationPreview/, "Initialize has no migration UI");
assert.match(commandsSource, /inspectPendingMerge/, "pending merge context is inspected");
assert.match(commandsSource, /inspectUndoEligibility/, "Undo visibility uses exact eligibility");
for (const command of cancellable) {
  assert.match(
    registeredCommandsSource,
    new RegExp(`registerCommand\\(context, output, "${command}", [^\\n]+, true,`),
    `${command} exposes network cancellation`
  );
}
for (const command of localOnly) {
  assert.match(
    registeredCommandsSource,
    new RegExp(`registerCommand\\(context, output, "${command}", [^\\n]+, false,`),
    `${command} remains non-cancellable`
  );
}
assert.equal(packageJson.dependencies?.["@firecrawl/anydoc-wasm"], undefined, "unused runtime dependency is absent");

console.log("WipStream generalized VS Code command-surface tests passed.");
