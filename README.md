# WipStream

WipStream is a VS Code extension for one person who works on a project using multiple computers. It uses the remote Git repository—not filesystem synchronization such as Dropbox or Syncthing—to synchronize changes across computers. This is safer for syncing both the working set in files and the local .git repo directory. 

WipStream is currently distributed as a `.vsix`; it is not published on the VS Code Marketplace.

## Model and Command Overview

The repository will have three branches:

```text
main ───── feature ───── wip/feature
```

- `main` contains completed work.
- `feature` is work on changes that you commit as the feature history.
- `wip/feature` is new work-in-process you are doing for the feature.  
  
`Save to Remote` creates a commit on the wip/feature branch and pushes it to remote so that you can access it from other computers where you also work on the repo. Once `Save to Remote` reports success, the remote is the authoritative state that another computer may download using the current from.

`To Feature` extends the `feature` branch to the latest `wip/feature` commit. No squash, rebase, merge, or force-push is necessary. If some WIP commits should be hidden, squash them manually before you run the `To Feature` command.

`Get Current from Remote` is the first command you must run on another computer before you edit anything in the project. This command pulls all changes on all of the branches to this computer.  Do not edit anything in the project until you do this first!

WipStream is designed for one active editing machine at a time and for one person. It is *not* team version management. 

## Prerequisites

- A normal, complete Git working clone with a reachable remote (default `origin`).
- Permission to create, update, and delete the configured temporary branches, and to fast-forward the configured main branch.
- A remote that supports Git atomic pushes. WipStream validates these pre-requisites during initialization.
- Git commit hooks are honored. If a hook rejects a checkpoint, it is not committed or pushed; Git leaves the changes staged so you can fix the problem and retry.

The default branch names are `origin`, `main`, `feature`, and `wip/feature`. Initialization offers these names and stores the chosen values in that clone’s `.git/config` under `wipstream.*`. Other branches are never touched.

## Commands

### WipStream: Initialize Stream (`wipstream:init`)

Use this once per clone for a feature stream. It saves buffers, requires a clean repository, fetches the remote, and either:

- creates and atomically publishes `feature` and `wip/feature` from `main`, or
- attaches the clone to an existing valid stream.

It then runs **Get Current from Remote** automatically and so that you can start an editing session on `wip/feature`. Its Output message confirms this and reminds you that before every subsequent editing session on any of your computers you must run **Get Current from Remote** yourself. 

### WipStream: Get Current from Remote (`wipstream:resume`)

Use this to start a session, especially after moving to another computer. It refuses to overwrite dirty buffers, uncommitted files, local-only commits, divergent branches, conflicts, or an active Git operation. After fetching and validating all branches, it safely updates the local clone on the machine and checks out `wip/feature`.

If another computer has already completed the feature, **Get Current from Remote** instead fast-forwards this clone’s `main`, removes only stale temporary branches already contained in that `main`, and leaves `main` checked out. It then tells you to run **Initialize Stream** when ready to start the next feature.

#### To use a second computer:

1. Clone the same remote normally using git--WipStream does *not* do this for you.
2. Open the clone in VS Code.
3. Run **Initialize Stream** to attach it and start the first session.
4. Before every later editing session, run **Get Current from Remote** before editing.

### WipStream: Save to Remote (`wipstream:saveup`)

This command commits and saves the current work to the remote:

1. Saves file-backed VS Code documents in the selected repository.
2. Requires `wip/feature` to be checked out.
3. Stages all changes, including new and deleted files.
4. When content has changed, prompts for a checkpoint commit message prefilled with a timestamped WIP message. Accept the default or replace it; then creates one checkpoint.
5. Atomically pushes `main`, `feature`, and `wip/feature` to the remote.

Files excluded by `.gitignore` and empty directories are not committed. If a submodule has uncommitted changes, commit or discard them within that submodule before saving the parent repository.

It reports whether the checkpoint is synced, whether there were no committable changes, whether work is local-only because the network is unavailable, or whether the remote changed. Do not move to another machine until it reports a successful sync.

### WipStream: To Feature (`wipstream:tofeature`)

First performs **Save to Remote**, including its checkpoint-message prompt when content has changed. Only after that successful handoff, it advances `feature` to `wip/feature` and atomically publishes the result. It is safe to repeat.

### WipStream: To Main (`wipstream:tomain`)

This is the commmand that completes the feature work and includes it in main.

Saves VS Code documents, then requires a clean working tree and exactly matching `feature` plus `wip/feature` refs. If WIP remains unaccepted, run **To Feature** first.

Fetches and rechecks the remote, fast-forwards `main` to `feature`, then atomically publishes `main` while deleting remote `feature` and `wip/feature`. After the remote succeeds, it deletes the local temporary branches and leaves `main` checked out.

## Recovery

**Get Current from Remote** intentionally refuses unexpected local work instead of guessing how to merge it. Either discard that work deliberately, or preserve it on a rescue branch:

```bash
git switch -c rescue/<timestamp>
git add --all
git commit -m "Rescue unexpected local work"
git push -u origin rescue/<timestamp> # strongly recommended
```

Then get current from WipStream normally and manually cherry-pick the rescue commits into `wip/feature` or `feature`. Resolve conflicts deliberately and run **Save to Remote** afterward.

## Install from a VSIX

WipStream is not yet published on the VS Code Marketplace. To install it, download the provided `.vsix` file, then in VS Code:

1. Open the Command Palette.
2. Run **Extensions: Install from VSIX...**.
3. Select the downloaded `.vsix` file.

Alternatively, from a terminal with the VS Code `code` command available:

```bash
code --install-extension /path/to/lewisl.wipstream-<version>.vsix
```

Reload VS Code if prompted.

## Development

Building a `.vsix` with npm is only needed when developing or testing WipStream locally:

```bash
npm install
npm test
npm run package
code --install-extension dist/lewisl.wipstream-0.1.6.vsix --force
```

Increment `version` in `package.json` for meaningful local test builds so installed versions are obvious.

`npm test` creates disposable local bare remotes and clones; it never contacts a network service. The optional `npm run test:remote` uses `/Users/lewislevin/code/makadoo` only when `WIPSTREAM_REMOTE_ACCEPTANCE=1` is set. It creates uniquely named temporary remote branches, never changes Makadoo’s real `main`, and preserves the unique branches after a failure for diagnosis.

For a manual live-extension test that never restarts or changes the VS Code instance running Codex, run:

```bash
npm run test:live
```

It packages the extension, creates a disposable bare remote plus two clones, installs the VSIX into a temporary VS Code user-data and extensions directory, and opens one isolated VS Code window per clone. Follow `LIVE_TEST.md` in those windows, then run the verification command printed by the launcher. The fixture is retained until you explicitly remove it with the printed cleanup command.

Each command writes a durable start, success, or error record to VS Code’s **WipStream** Output channel and opens that panel when it completes. WipStream also requests a normal information/error notification, but the Output channel is the reliable command record.
