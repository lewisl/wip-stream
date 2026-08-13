const { execFileSync } = require("child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");

if (process.env.WIPSTREAM_REMOTE_ACCEPTANCE !== "1") {
  console.log("Skipped Makadoo remote acceptance test. Set WIPSTREAM_REMOTE_ACCEPTANCE=1 to run it.");
  process.exit(0);
}

const { GitRepository } = require("../out/git");
const { initialize, resume, saveUp, toFeature, toMain } = require("../out/workflow");

const makadoo = "/Users/lewislevin/code/makadoo";
if (!existsSync(makadoo)) {
  throw new Error(`Makadoo fixture is unavailable at ${makadoo}.`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configureIdentity(directory) {
  git(directory, ["config", "user.name", "WipStream Acceptance Test"]);
  git(directory, ["config", "user.email", "wipstream-acceptance@example.invalid"]);
}

async function main() {
  if (git(makadoo, ["status", "--porcelain=v1"]) !== "") {
    throw new Error("Makadoo must be clean before the opt-in remote acceptance test runs.");
  }

  git(makadoo, ["fetch", "--prune", "origin"]);
  const remoteUrl = git(makadoo, ["remote", "get-url", "origin"]);
  const runId = `${Date.now()}-${process.pid}`;
  const prefix = `wipstream-acceptance/${runId}`;
  const config = {
    remote: "origin",
    mainBranch: `${prefix}/main`,
    featureBranch: `${prefix}/feature`,
    wipBranch: `${prefix}/wip`,
  };
  const fixture = mkdtempSync(path.join(os.tmpdir(), "wipstream-makadoo-"));
  const firstPath = path.join(fixture, "first");
  const secondPath = path.join(fixture, "second");
  let succeeded = false;

  try {
    git(makadoo, ["push", "--atomic", "origin", `origin/main:refs/heads/${config.mainBranch}`]);
    git(fixture, ["clone", remoteUrl, firstPath]);
    configureIdentity(firstPath);
    const first = await GitRepository.open(firstPath);
    await initialize(first, config);
    writeFileSync(path.join(firstPath, ".wipstream-acceptance.txt"), `run ${runId}\n`);
    const saved = await saveUp(first);
    if (!saved.published) {
      throw new Error("The acceptance checkpoint did not publish to Makadoo.");
    }
    await toFeature(first);

    git(fixture, ["clone", remoteUrl, secondPath]);
    configureIdentity(secondPath);
    const second = await GitRepository.open(secondPath);
    await initialize(second, config);
    await toMain(second);
    succeeded = true;
    console.log(`Makadoo acceptance test passed for ${prefix}.`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    if (succeeded) {
      git(makadoo, ["push", "--atomic", "origin", `:${config.mainBranch}`, `:${config.featureBranch}`, `:${config.wipBranch}`]);
      console.log(`Deleted acceptance branches under ${prefix}.`);
    } else {
      console.log(`Acceptance branches under ${prefix} were preserved for diagnosis.`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
