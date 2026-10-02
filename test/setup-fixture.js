const { execFileSync } = require("child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("fs");
const os = require("os");
const path = require("path");
const { GitRepository } = require("../out/git");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function identity(directory) {
  git(directory, ["config", "user.name", "WipStream Setup Test"]);
  git(directory, ["config", "user.email", "setup@example.invalid"]);
}

function commitFile(directory, name, contents, message = "Update files") {
  writeFileSync(path.join(directory, name), contents);
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-m", message]);
}

function heads(directory) {
  return git(directory, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
}

async function withFixture(action, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), options.prefix || "wipstream-setup-"));
  try {
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "-b", "main", seed]);
    identity(seed);
    commitFile(seed, options.initialFile || "main.txt", options.initialContents || "baseline\n", "Initial commit");
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const clone = async (name) => {
      const directory = path.join(root, name);
      git(root, ["clone", remote, directory]);
      identity(directory);
      return { directory, repo: await GitRepository.open(directory) };
    };
    await action({ root, remote, seed, clone });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { git, identity, commitFile, heads, withFixture };
