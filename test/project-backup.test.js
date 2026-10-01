const assert = require("assert/strict");
const { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } = require("fs");
const path = require("path");
const { GitRepository } = require("../out/git");
const { createProjectBackup, ProjectBackupError } = require("../out/project-backup");
const { listOperationReceipts } = require("../out/operations");
const { git, commitFile, heads, withFixture } = require("./setup-fixture");

async function completeOrdinaryBackup() {
  await withFixture(async ({ root, remote, clone }) => {
    const local = await clone("local");
    git(local.directory, ["switch", "-c", "local-work"]);
    commitFile(local.directory, "committed.txt", "local history\n");
    git(local.directory, ["tag", "local-tag"]);
    writeFileSync(path.join(local.directory, ".gitignore"), "ignored-cache/\n");
    mkdirSync(path.join(local.directory, "ignored-cache"), { mode: 0o750 });
    writeFileSync(path.join(local.directory, "ignored-cache", "cache.txt"), "ignored content\n");
    writeFileSync(path.join(local.directory, "main.txt"), "staged\n");
    git(local.directory, ["add", "main.txt"]);
    writeFileSync(path.join(local.directory, "main.txt"), "unstaged\n");
    writeFileSync(path.join(local.directory, "untracked space\nand newline.txt"), "untracked\n");
    writeFileSync(path.join(local.directory, "executable.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(local.directory, "executable.sh"), 0o755);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "do-not-copy.txt"), "outside project\n");
    symlinkSync(outside, path.join(local.directory, "external-link"));
    symlinkSync("missing-target", path.join(local.directory, "broken-link"));
    const originalHeads = heads(local.directory);
    const originalRemote = heads(remote);
    const index = readFileSync(path.join(local.directory, ".git", "index"));
    const backup = await createProjectBackup(local.repo, root);
    assert.equal(backup.verified, true);
    assert.match(path.basename(backup.path), /^local-backup-\d{4}-/);
    assert.equal(path.dirname(backup.path), realpathSync(root));
    const copied = await GitRepository.open(backup.path);
    assert.equal(await copied.currentBranch(), "local-work");
    assert.equal(heads(backup.path), originalHeads);
    assert.equal(git(backup.path, ["rev-parse", "local-tag"]), git(local.directory, ["rev-parse", "local-tag"]));
    assert.deepEqual(readFileSync(path.join(backup.path, ".git", "index")), index);
    assert.equal(readFileSync(path.join(backup.path, "main.txt"), "utf8"), "unstaged\n");
    assert.equal(readFileSync(path.join(backup.path, "ignored-cache", "cache.txt"), "utf8"), "ignored content\n");
    assert.equal(readFileSync(path.join(backup.path, "untracked space\nand newline.txt"), "utf8"), "untracked\n");
    assert.equal(lstatSync(path.join(backup.path, "executable.sh")).mode & 0o7777, 0o755);
    assert.equal(lstatSync(path.join(backup.path, "ignored-cache")).mode & 0o7777, 0o750);
    assert.equal(lstatSync(path.join(backup.path, "external-link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(backup.path, "external-link")), outside);
    assert.equal(readlinkSync(path.join(backup.path, "broken-link")), "missing-target");
    assert.equal(existsSync(path.join(backup.path, ".git", "wipstream", "command.lock")), false);
    assert.deepEqual(await listOperationReceipts(local.repo), [], "backup creates no replacement receipt");
    assert.equal(heads(local.directory), originalHeads);
    assert.equal(heads(remote), originalRemote);
  });
}

async function destinationGuards() {
  await withFixture(async ({ root, clone }) => {
    const local = await clone("local");
    mkdirSync(path.join(local.directory, "child"));
    const link = path.join(root, "parent-link");
    symlinkSync(path.join(local.directory, "child"), link);
    for (const parent of [local.directory, path.join(local.directory, "child"), link]) {
      await assert.rejects(() => createProjectBackup(local.repo, parent), error => error instanceof ProjectBackupError && error.code === "INVALID_BACKUP_DESTINATION" && !error.backupPath);
    }
    const existing = path.join(root, "already-exists");
    mkdirSync(existing);
    writeFileSync(path.join(existing, "sentinel.txt"), "do not overwrite\n");
    await assert.rejects(() => createProjectBackup(local.repo, root, { folderName: "already-exists" }), error => error.code === "EEXIST" && !error.backupPath);
    assert.equal(readFileSync(path.join(existing, "sentinel.txt"), "utf8"), "do not overwrite\n");
    for (const name of ["../escape", ".", "nested/folder", "nested\\folder"]) {
      await assert.rejects(() => createProjectBackup(local.repo, root, { folderName: name }), error => error.code === "INVALID_BACKUP_DESTINATION");
    }
  });
}

async function cancellationAndFailedWrites() {
  await withFixture(async ({ root, clone }) => {
    const local = await clone("local");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => createProjectBackup(local.repo, root, { signal: controller.signal }), error => error.code === "CANCELLED" && !error.backupPath);
    const midCopy = new AbortController();
    await assert.rejects(() => createProjectBackup(local.repo, root, {
      signal: midCopy.signal,
      beforeCopyEntry: async name => { if (name === "main.txt") midCopy.abort(); },
    }), error => error.code === "CANCELLED" && existsSync(error.backupPath) && /Incomplete backup retained/.test(error.message));
    for (const code of ["ENOSPC", "EACCES"]) {
      await assert.rejects(() => createProjectBackup(local.repo, root, {
        beforeCopyEntry: async name => { if (name === "main.txt") throw Object.assign(new Error("Injected write failure"), { code }); },
      }), error => error.code === code && existsSync(error.backupPath) && /has not been verified/.test(error.message));
    }
    assert.deepEqual(await listOperationReceipts(local.repo), []);
    assert.equal(readFileSync(path.join(local.directory, "main.txt"), "utf8"), "baseline\n");
  });
}

async function concurrentChangesAndVerificationFailure() {
  await withFixture(async ({ root, clone }) => {
    const local = await clone("local");
    await assert.rejects(() => createProjectBackup(local.repo, root, {
      beforeCopyEntry: async name => { if (name === "main.txt") writeFileSync(path.join(local.directory, "main.txt"), "changed during copy\n"); },
    }), error => error.code === "PROJECT_CHANGED" && existsSync(error.backupPath));
    await assert.rejects(() => createProjectBackup(local.repo, root, {
      afterCopy: async backup => { writeFileSync(path.join(backup, "main.txt"), "corrupted copy\n"); },
    }), error => error.code === "BACKUP_VERIFICATION_FAILED" && existsSync(error.backupPath));
    // Restoring identical bytes does not erase evidence of an intervening write.
    await assert.rejects(() => createProjectBackup(local.repo, root, {
      afterCopy: async () => {
        const filename = path.join(local.directory, "main.txt");
        const original = readFileSync(filename);
        writeFileSync(filename, "temporary source change\n");
        writeFileSync(filename, original);
      },
    }), error => error.code === "PROJECT_CHANGED");
    assert.deepEqual(await listOperationReceipts(local.repo), []);
  });
}

async function externalGitStorageRefusals() {
  await withFixture(async ({ root, remote, clone }) => {
    const shared = path.join(root, "shared");
    git(root, ["clone", "--shared", remote, shared]);
    const sharedRepo = await GitRepository.open(shared);
    await assert.rejects(() => createProjectBackup(sharedRepo, root), error => error.code === "EXTERNAL_GIT_STORAGE" && !error.backupPath);
    const partial = await clone("partial");
    git(partial.directory, ["config", "remote.origin.promisor", "true"]);
    await assert.rejects(() => createProjectBackup(partial.repo, root), error => error.code === "EXTERNAL_GIT_STORAGE" && !error.backupPath);
    const local = await clone("local");
    git(local.directory, ["init", `--separate-git-dir=${path.join(root, "separate-storage")}`]);
    const separateRepo = await GitRepository.open(local.directory);
    await assert.rejects(() => createProjectBackup(separateRepo, root), error => error.code === "EXTERNAL_GIT_STORAGE" && !error.backupPath);
  });
}

Promise.resolve().then(completeOrdinaryBackup).then(destinationGuards).then(cancellationAndFailedWrites)
  .then(concurrentChangesAndVerificationFailure).then(externalGitStorageRefusals)
  .then(() => console.log("WipStream complete project backup tests passed."))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
