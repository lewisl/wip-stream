const assert = require("assert/strict");
const { readFileSync } = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const commandsSource = readFileSync(path.join(root, "src", "commands.ts"), "utf8");

const primary = [
  { id: "wipstream.init", title: "Initialize Repository", key: "ctrl+w i" },
  { id: "wipstream.resume", title: "Get from Remote", key: "ctrl+w g" },
  { id: "wipstream.saveup", title: "Commit and Save", key: "ctrl+w s" },
];
const contextual = [
  ["wipstream.start", "wipstream.version2"],
  ["wipstream.finish", "wipstream.finishAvailable"],
  ["wipstream.update", "wipstream.updateAvailable"],
  ["wipstream.reconcile", "wipstream.reconcileAvailable"],
  ["wipstream.continue", "wipstream.pendingMerge"],
  ["wipstream.abort", "wipstream.pendingMerge"],
  ["wipstream.undo", "wipstream.undoAvailable"],
  ["wipstream.condense", "wipstream.condenseAvailable"],
];
const legacy = ["wipstream.tofeature", "wipstream.tomain"];

const declared = new Map(packageJson.contributes.commands.map(({ command, title }) => [command, title]));
for (const { id, title } of primary) assert.equal(declared.get(id), title);
for (const [id] of contextual) assert.ok(declared.has(id), `${id} is declared`);
for (const id of legacy) assert.ok(declared.has(id), `${id} remains declared for one compatibility release`);

assert.deepEqual(
  packageJson.contributes.keybindings,
  primary.map(({ id, key }) => ({ command: id, key })),
  "normal use retains only the three primary chords"
);

const palette = new Map(packageJson.contributes.menus.commandPalette.map(({ command, when }) => [command, when]));
for (const [id, when] of contextual) assert.equal(palette.get(id), when, `${id} has contextual visibility`);
for (const id of legacy) assert.equal(palette.get(id), "false", `${id} is callable but hidden from normal UI`);

for (const id of [...primary.map(({ id }) => id), ...contextual.map(([id]) => id), ...legacy]) {
  assert.ok(packageJson.activationEvents.includes(`onCommand:${id}`), `${id} activates the extension`);
  assert.ok(commandsSource.includes(`register("${id.replace("wipstream.", "")}"`), `${id} has a registered handler`);
}

assert.match(commandsSource, /operation=\$\{operationId\}/, "Output records include operation ids");
assert.match(commandsSource, /confirmMigrationPreview/, "Initialize exposes the version 1 migration preview");
assert.match(commandsSource, /inspectPendingMerge/, "pending merge context is inspected");
assert.match(commandsSource, /inspectUndoEligibility/, "Undo visibility uses exact eligibility");
assert.match(commandsSource, /no separate accepted\/WIP branch/, "legacy To Feature explains the v2 model");
assert.match(commandsSource, /use Finish Branch/, "legacy To Main delegates users to generalized Finish after migration");

console.log("WipStream generalized VS Code command-surface tests passed.");
