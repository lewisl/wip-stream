const { execFileSync } = require("child_process");
const { lstatSync, readFileSync, readlinkSync } = require("fs");
const path = require("path");

function gitBytes(directory, args) {
  return execFileSync("git", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
}

function workingFiles(directory) {
  const names = gitBytes(directory, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .toString("utf8").split("\0").filter(Boolean);
  return [...new Set(names)].sort().map(name => {
    const filename = path.join(directory, name);
    let stat;
    try {
      stat = lstatSync(filename);
    } catch (error) {
      if (error.code === "ENOENT") return { name, missing: true };
      throw error;
    }
    return stat.isSymbolicLink()
      ? { name, target: readlinkSync(filename) }
      : { name, contents: readFileSync(filename), mode: stat.mode & 0o777 };
  });
}

// Capture user-visible state independently of the workflow's own checks.
// Tracking refs are deliberately excluded: refusals may legitimately fetch.
async function repositoryState(repo, remoteDirectory) {
  return {
    branch: await repo.currentBranch(),
    head: gitBytes(repo.root, ["rev-parse", "HEAD"]),
    refs: gitBytes(repo.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/", "refs/wipstream/recovery/"]),
    remote: gitBytes(remoteDirectory, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]),
    config: gitBytes(repo.root, ["config", "--local", "--list", "-z"]),
    status: gitBytes(repo.root, ["status", "--porcelain=v1", "-z"]),
    staged: gitBytes(repo.root, ["diff", "--cached", "--binary"]),
    unstaged: gitBytes(repo.root, ["diff", "--binary"]),
    files: workingFiles(repo.root),
  };
}

module.exports = { gitBytes, repositoryState };
