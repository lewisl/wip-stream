const { spawnSync } = require("child_process");
const path = require("path");

// These remain ordinary Node scripts. Platform restrictions are explicit so
// skipping a filesystem-specific suite cannot look like full validation.
const suites = [
  { file: "git", posix: "executable fake Git and POSIX process signals" },
  { file: "repository-model" },
  { file: "repository-safety" },
  { file: "operations" },
  { file: "receipt-reader" },
  { file: "get-from-remote" },
  { file: "initialize-repository" },
  { file: "commit-and-save", posix: "executable shell hooks" },
  { file: "setup-inspection", posix: "executable shell hooks" },
  { file: "setup-workflow", posix: "executable shell hooks" },
  { file: "project-backup", posix: "symlink permissions and executable file modes" },
  { file: "remote-adoption", posix: "symlinks" },
  { file: "remote-adoption-recovery" },
  { file: "lifecycle-workflow" },
  { file: "lifecycle-recovery" },
  { file: "workflow-refusals" },
  { file: "conflict-workflow" },
  { file: "recovery-workflow" },
  { file: "undo-workflow" },
  { file: "public-command-sequences" },
  { file: "command-surface" },
  { file: "command-context" },
  { file: "command-handlers" },
  { file: "setup-ui" },
  { file: "review-regressions" },
];

const portableOnly = process.argv.includes("--portable") || process.platform === "win32";
let passed = 0;
let skipped = 0;
for (const suite of suites) {
  if (portableOnly && suite.posix) {
    console.log(`SKIP ${suite.file}: ${suite.posix}`);
    skipped++;
    continue;
  }
  const args = [path.join(__dirname, `${suite.file}.test.js`)];
  if (portableOnly && suite.file === "review-regressions") {
    args.push("receipts", "undo", "initialize", "lifecycle", "recovery");
    console.log("SKIP review-regressions output/inspection: symlinks, executable modes, and Unix sockets");
  }
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`FAIL ${suite.file}: ${result.error || result.signal || `exit ${result.status}`}`);
    process.exit(result.status || 1);
  }
  passed++;
}
console.log(`WipStream ${portableOnly ? "portable subset" : "full suite"}: ${passed} scripts passed; ${skipped} scripts skipped.`);
