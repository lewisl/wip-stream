# WipStream

WipStream is a VS Code extension for one person moving an unfinished Git feature safely between computers. It uses the remote Git repository—not filesystem synchronization—as the handoff point.

WipStream is currently intended for local development and testing. Install it from a `.vsix`; it is not published on the VS Code Marketplace.

## Model

An active stream has three branches:

```text
main ───── feature ───── wip/feature
```

- `main` contains completed work.
- `feature` contains WIP commits that you have explicitly accepted as feature history.
- `wip/feature` is the normal checked-out branch. `Save to Remote` adds checkpoint commits here.

`To Feature` moves `feature` to the exact current `wip/feature` commit. It does not squash, rebase, merge, or force-push. If some WIP commits should be hidden, squash them manually before running `To Feature`.

WipStream is designed for one active editing machine at a time. Once `Save to Remote` reports success, the remote is the authoritative state that another computer may get current from.

## Prerequisites

- A normal, complete Git working clone with a reachable remote (default `origin`).
- Permission to create, update, and delete the configured temporary branches, and to fast-forward the configured main branch.
- A remote that supports Git atomic pushes. WipStream validates this during initialization.
- Git commit hooks are honored. If a hook rejects a checkpoint, it is not committed or pushed.

The defaults are `origin`, `main`, `feature`, and `wip/feature`. Initialization offers these names and stores the chosen values in that clone’s `.git/config` under `wipstream.*`. Other branches are never touched.

## Commands

### WipStream: Initialize Stream (`wipstream:init`)

Use this once per clone for a feature stream. It saves buffers, requires a clean repository, fetches the remote, and either:

- creates and atomically publishes `feature` and `wip/feature` from `main`, or
- attaches the clone to an existing valid stream.

It then runs **Get Current from Remote** automatically and starts the first editing session on `wip/feature`. Its complete Output message says that this happened and reminds you of the later-session rule: before every later editing session, run **Get Current from Remote** yourself.

### WipStream: Get Current from Remote (`wipstream:resume`)

Use this to start a session, especially after moving to another computer. It refuses to overwrite dirty buffers, uncommitted files, local-only commits, divergent branches, conflicts, or an active Git operation. After fetching and validating all branches, it safely updates this clone and checks out `wip/feature`.

If another computer has already completed the feature, **Get Current from Remote** instead fast-forwards this clone’s `main`, removes only stale temporary branches already contained in that `main`, and leaves `main` checked out. It then tells you to run **Initialize Stream** when ready to start the next feature.

To use a second computer:

1. Clone the same remote normally.
2. Open the clone in VS Code.
3. Run **Initialize Stream** to attach it and start the first session.
4. Before every later editing session, run **Get Current from Remote** before editing.

### WipStream: Save to Remote (`wipstream:saveup`)

This is the explicit handoff command:

1. Saves file-backed VS Code documents in the selected repository.
2. Requires `wip/feature` to be checked out.
3. Stages all changes, including new and deleted files.
4. Creates one timestamped WIP checkpoint only when content changed.
5. Atomically pushes `main`, `feature`, and `wip/feature`.

It reports whether the checkpoint is synced, already synced, local-only because the network is unavailable, or local-only because the remote changed. Do not move to another machine until it reports a successful sync.

### WipStream: To Feature (`wipstream:tofeature`)

First performs **Save to Remote**. Only after that successful handoff, it advances `feature` to `wip/feature` and atomically publishes the result. It is safe to repeat.

### WipStream: To Main (`wipstream:tomain`)

Saves VS Code documents, then requires a clean working tree and exactly matching `feature` plus `wip/feature` refs. If WIP remains unaccepted, run **To Feature** first.

It fetches and rechecks the remote, fast-forwards `main` to `feature`, then atomically publishes `main` while deleting remote `feature` and `wip/feature`. After the remote succeeds, it deletes the local temporary branches and leaves `main` checked out.

## Recovery

**Get Current from Remote** intentionally refuses unexpected local work instead of guessing how to merge it. Either discard that work deliberately, or preserve it on a rescue branch:

```bash
git switch -c rescue/<timestamp>
git add --all
git commit -m "Rescue unexpected local work"
git push -u origin rescue/<timestamp> # strongly recommended
```

Then get current from WipStream normally and manually cherry-pick the rescue commits into `wip/feature` or `feature`. Resolve conflicts deliberately and run **Save to Remote** afterward.

## Local VSIX development

The usual local build and install sequence is:

```bash
npm install
npm test
npm run package
code --install-extension dist/lewisl.wipstream-0.1.6.vsix --force
```

Alternatively use VS Code’s **Extensions: Install from VSIX...** command. Increment `version` in `package.json` for meaningful local test builds so installed versions are obvious.

`npm test` creates disposable local bare remotes and clones; it never contacts a network service. The optional `npm run test:remote` uses `/Users/lewislevin/code/makadoo` only when `WIPSTREAM_REMOTE_ACCEPTANCE=1` is set. It creates uniquely named temporary remote branches, never changes Makadoo’s real `main`, and preserves the unique branches after a failure for diagnosis.

For a manual live-extension test that never restarts or changes the VS Code instance running Codex, run:

```bash
npm run test:live
```

It packages the extension, creates a disposable bare remote plus two clones, installs the VSIX into a temporary VS Code user-data and extensions directory, and opens one isolated VS Code window per clone. Follow `LIVE_TEST.md` in those windows, then run the verification command printed by the launcher. The fixture is retained until you explicitly remove it with the printed cleanup command.

Each command writes a durable start, success, or error record to VS Code’s **WipStream** Output channel and opens that panel when it completes. WipStream also requests a normal information/error notification, but the Output channel is the reliable command record.
