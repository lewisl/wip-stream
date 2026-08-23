const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { GitError, GitRepository } = require("../out/git");

async function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wipstream-git-process-"));
  const bin = path.join(fixture, "bin");
  const capture = path.join(fixture, "stdin.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "rev-parse") {
  process.stdout.write(process.cwd() + "\\n");
} else if (args[0] === "worktree") {
  process.stdout.write("worktree " + process.cwd() + "\\0HEAD 1111111111111111111111111111111111111111\\0branch refs/heads/main\\0\\0");
} else if (args[0] === "probe-stdin") {
  process.stdin.on("end", () => process.stdout.write("eof\\n"));
  process.stdin.resume();
} else if (args[0] === "check-ref-format") {
  process.exitCode = 0;
} else if (args[0] === "update-ref") {
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => fs.writeFileSync(process.env.WIPSTREAM_FAKE_CAPTURE, input));
} else if (args[0] === "exit-seven") {
  process.stderr.write("seven\\n");
  process.exitCode = 7;
} else if (args[0] === "terminate") {
  process.kill(process.pid, "SIGTERM");
} else if (args[0] === "fetch") {
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalCapture = process.env.WIPSTREAM_FAKE_CAPTURE;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  process.env.WIPSTREAM_FAKE_CAPTURE = capture;
  try {
    const repo = await GitRepository.open(fixture);
    assert.equal(await repo.run(["probe-stdin"]), "eof", "ordinary Git commands receive closed stdin");

    await repo.updateRefs([{
      ref: "refs/heads/topic",
      expectedOld: null,
      proposed: "2222222222222222222222222222222222222222",
    }]);
    assert.match(fs.readFileSync(capture, "utf8"), /^start\ncreate refs\/heads\/topic 2+\nprepare\ncommit\n$/);

    await assert.rejects(
      () => repo.run(["exit-seven"]),
      (error) => error instanceof GitError
        && error.code === "GIT_COMMAND_FAILED"
        && error.exitCode === 7
        && error.signal === undefined
    );

    await assert.rejects(
      () => repo.run(["terminate"]),
      (error) => error instanceof GitError
        && error.code === "GIT_COMMAND_TERMINATED"
        && error.exitCode === undefined
        && error.signal === "SIGTERM"
        && !error.cancelled
        && error.args[0] === "terminate"
    );

    const controller = new AbortController();
    const fetch = repo.withNetworkCancellation(controller.signal).fetchAllBranches("origin");
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(
      () => fetch,
      (error) => error instanceof GitError
        && error.code === "GIT_COMMAND_CANCELLED"
        && error.cancelled
        && error.exitCode === undefined
        && error.signal === "SIGTERM"
        && error.args[0] === "fetch"
    );
  } finally {
    process.env.PATH = originalPath;
    if (originalCapture === undefined) delete process.env.WIPSTREAM_FAKE_CAPTURE;
    else process.env.WIPSTREAM_FAKE_CAPTURE = originalCapture;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

run().then(
  () => console.log("WipStream Git process tests passed."),
  (error) => { console.error(error); process.exitCode = 1; }
);
