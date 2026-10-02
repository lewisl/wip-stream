const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// VS Code loads this export in an isolated extension test host.
exports.run = async function runInExtensionHost() {
  const vscode = require("vscode");
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const resultPath = path.join(path.dirname(workspace), "startup-result.json");
  try {
    const extension = vscode.extensions.getExtension("lewisl.wipstream");
    assert.ok(extension, "the development extension is loaded");
    const deadline = Date.now() + 20000;
    while (!extension.isActive && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(extension.isActive, true, "startup activates WipStream before any WipStream command is invoked");
    const commands = await vscode.commands.getCommands(true);
    for (const name of ["init", "resume", "saveup", "start", "finish", "update", "reconcile", "continue", "abort", "recover", "undo", "condense"]) {
      assert.ok(commands.includes(`wipstream.${name}`), `${name} is registered in the fresh host`);
    }
    const { GitRepository } = require("../out/git");
    const { inspectUndoEligibility } = require("../out/undo-workflow");
    const repo = await GitRepository.open(workspace);
    assert.equal((await inspectUndoEligibility(repo)).eligible, true);
    assert.equal(await repo.currentBranch(), "startup-feature");
    // Exercise a real command adapter after proving automatic activation.
    await vscode.commands.executeCommand("wipstream.resume");
    assert.equal(await repo.currentBranch(), "startup-feature");
    fs.writeFileSync(resultPath, JSON.stringify({ passed: true }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ passed: false, error: error.stack || String(error) }));
    throw error;
  }
};

async function launchIsolatedHost() {
  const { withFixture } = require("./setup-fixture");
  const { inspectRepositorySetup, executeRepositorySetup } = require("../out/setup-workflow");
  const { startBranch } = require("../out/lifecycle-workflow");
  const { commitAndSave } = require("../out/generalized-workflow");
  await withFixture(async ({ root, clone }) => {
    const { directory, repo } = await clone("startup");
    const result = await executeRepositorySetup(repo, await inspectRepositorySetup(repo), { kind: "local-work" });
    assert.equal(result.kind, "completed", result.message);
    await startBranch(repo, "startup-feature");
    fs.writeFileSync(path.join(directory, "feature.txt"), "startup work\n");
    assert.equal((await commitAndSave(repo)).published, true);
    const launched = spawnSync("code", [
      "--new-window", "--wait", "--disable-extensions", "--disable-workspace-trust",
      "--skip-welcome", "--skip-release-notes",
      `--user-data-dir=${path.join(root, "profile")}`,
      `--extensions-dir=${path.join(root, "extensions")}`,
      `--extensionDevelopmentPath=${path.resolve(__dirname, "..")}`,
      `--extensionTestsPath=${__filename}`,
      directory,
    ], { encoding: "utf8", timeout: 60000 });
    const resultPath = path.join(root, "startup-result.json");
    assert.ok(fs.existsSync(resultPath), `The test host produced no result: ${launched.error || launched.stderr || launched.stdout}`);
    const checked = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(checked.passed, true, checked.error);
    assert.equal(launched.status, 0, launched.stderr);
    console.log("WipStream isolated VS Code startup and command-adapter tests passed.");
  });
}

if (require.main === module) {
  launchIsolatedHost().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
