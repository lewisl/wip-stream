# WipStream

WipStream helps one person save work in progress and continue it on another
computer. Work on a named branch, **Commit and Save** before leaving a computer,
and **Get from Remote** before editing on the next one.

Use one editing clone at a time. Keep completed work on `main` (or your remote's
default branch), and develop on work branches. This is a workflow convention;
WipStream does not prohibit committing directly on `main`.

## Set up each computer

1. Install the WipStream `.vsix` using **Extensions: Install from VSIX...** in
   VS Code. Reload the window if prompted. WipStream is not on the Marketplace.
2. Open a normal, complete Git clone with a configured remote, usually `origin`.
3. Run **WipStream: Initialize Repository** in each clone. Local changes and
   existing commits are allowed; choose which work to keep as described below.
   Successful setup checks out the remote default branch.
4. Use **Start Branch** for new work, or select an existing work branch using
   VS Code's Git branch picker, Fork, or Git itself.

The remote must identify a default branch. Publishing through WipStream also
requires atomic pushes and permission to create, update, and delete branches.
Separate ordinary clones are supported; linked Git worktrees and shallow clones
are not.

### Choose the authoritative work

Initialize inspects actual files and all ordinary branches, even if a copied
project already carries WipStream configuration. A clean matching clone can
finish setup without extra decisions. Otherwise choose:

- **Use the remote’s version.** Every ordinary local branch will match the
  selected remote: missing branches are created and local-only branches removed.
  Tracked files are replaced; non-ignored untracked files are removed. Ignored
  files are preserved, and collisions with remote files block replacement.
  This path never pushes, merges, or creates a content commit.
- **Commit this machine’s work and save to remote.** Save editor documents,
  checkpoint non-ignored changes, and synchronize safe advances across all
  ordinary branches, including existing local commits and local-only branches.
  Commit hooks are honored. If history diverges, the checkpoint stays locally
  and nothing is published.
- **Resolve differences locally, then save to remote.** Keep current work and
  reconcile the named branches in your Git tool. Incorporate remote history;
  matching file contents alone is not enough. Rerun Initialize and choose
  **Commit this machine’s work and save to remote**. An externally completed
  merge is reused rather than recreated.

For remote authority, choose **Copy project, then use remote**, explicitly
confirm **Use remote without a backup**, or cancel. The folder picker starts at
the project's parent. Choose a parent outside the project; WipStream creates a
new timestamped folder there, never overwriting another folder. It copies and
verifies the entire self-contained project, including `.git`, ignored and
untracked files, permissions, and symbolic links. External Git storage and
special files that cannot be safely copied are refused. Remote replacement
currently refuses submodule checkouts; use your Git tool and the local-work path
for those projects.

The full backup path is displayed with **Open Backup Folder**. A backup is an
ordinary folder you can inspect separately. Copy desired changes back, then
**Commit and Save**; on another computer, **Get from Remote**. WipStream never
automatically restores, publishes, or deletes the backup. Remote adoption is
not eligible for **Undo Last Action**: restoring refs cannot restore discarded
uncommitted files.

Cancel is available throughout setup. Saving editor documents or changing
files, refs, configuration, or buffers after inspection requires an updated
preview and a fresh choice. A local checkpoint is not proof of successful
remote saving; wait for completion before continuing on another computer.

### Move away from folder synchronization

Each computer needs an independent ordinary clone. Stop the previous folder
sync service from modifying those project folders before using WipStream;
do not synchronize their `.git` directories. Initialize can adopt a copied
project's actual state, but it cannot make concurrent folder synchronization
safe. Configuring or disabling the external sync service is your responsibility.

## Start a new task

Choose the branch you eventually want the work incorporated into, then run
**WipStream: Start Branch** and give the task a descriptive name, such as
`histories-rewrite`.

| What is checked out | Start Branch creates | Finish Branch will incorporate it into |
| --- | --- | --- |
| `main` | `histories-rewrite` based on `main` | `main` |
| `feature` | `histories-rewrite` based on `feature` | `feature` |

Start Branch switches to the new branch. The original branch remains at its
existing commit. Any uncommitted changes carry into the new branch without
being committed. Later commits advance the new branch.

`feature` is an ordinary branch name, not a special WipStream branch. A **clean**
branch has no uncommitted file changes; that does not mean its work has been
incorporated into `main` or synchronized with the remote.

Switch between existing branches using your Git client. WipStream has no
general branch-switching command.

## Save work without finishing the task

Run **WipStream: Commit and Save** whenever you want to checkpoint and publish
your work. You can use it repeatedly while a task is unfinished.

It saves file-backed VS Code documents in the selected repository, stages all
non-ignored additions, changes, and deletions, and asks for a commit message if
there are staged changes. This includes work you had not staged yourself.
Existing commits made in Fork or another Git client are included in the handoff.

It then fetches and synchronizes safe advances across **all ordinary branches**,
not just the checked-out branch. Files ignored by Git and empty directories are
not included. Commit hooks are honored; dirty submodules must be handled first.

Wait for the successful handoff message. A local checkpoint can succeed while
publication fails. If WipStream says the handoff failed, stay on this computer
and resolve the reported problem before continuing elsewhere.

## Continue on another computer

1. On computer A, **Commit and Save** and wait for success.
2. On computer B, open its existing clone and run **Get from Remote before
   editing**. Initialize first if this is a newly created clone.
3. Select the intended work branch with your Git client if necessary.
4. Work normally. Before returning to A, **Commit and Save** on B, then **Get
   from Remote** on A.

Get retrieves the remote state for all ordinary branches, including newly
published branches and safe deletions. It normally preserves the checkout; if
that branch was deleted remotely, it selects its recorded parent or the remote
default branch. It refuses dirty files, unpublished local work, divergent
history, and ambiguous deletions rather than replacing them.

You do **not** need to Finish Branch to switch computers. Finish means the task
is complete and ready to incorporate into its parent.

## Finish a completed task

Check out the completed work branch and run **WipStream: Finish Branch**.

1. WipStream identifies the destination parent. For a branch created outside
   WipStream, it asks you to confirm or replace the assumed parent.
2. The confirmation names both branches, for example **Finish
   “histories-rewrite” into “main”?** Choose whether to retain the finished
   branch or delete it locally and remotely. Cancelling here does not save or
   publish your work.
3. WipStream runs Commit and Save, verifies that the work branch contains its
   parent's history, and advances the parent to the finished branch's commit
   locally and remotely. This is a fast-forward; existing parent history stays
   included.
4. It checks out the parent and retains or deletes the finished branch as chosen.

If the parent advanced independently, run **Update from Parent** and resolve
any conflicts, then retry Finish. Parent changes can result from your own work
on another branch, even with one user and one active computer.

If you started from `feature`, Finish incorporates the work into `feature`.
Finishing `feature` into `main` is a separate action. After finishing into
`main`, use Start Branch for the next task before editing.

## Using Fork, VS Code Git, or the Git command line

These tools can stage, commit, and switch branches in the same clone. Do not
run competing Git mutations simultaneously with a WipStream command.

A normal local commit can be published by Commit and Save. Amending or rebasing
an already-published commit can create different local and remote histories,
even when the files look the same. **History divergence is not itself a file
conflict.** WipStream uses Git's merge operation to reconcile those histories;
identical file trees can merge without file changes while retaining both histories.

If Commit and Save reports divergence on the checked-out branch, run
**Reconcile with Remote**. It requires a clean working directory, merges the
fetched remote history, and saves the result. For divergence on another branch,
select that branch with your Git client and address the reported condition.

## Working outside VS Code

For occasional work outside VS Code, in an existing Git clone. Assume the usual
Git settings, one remote named `origin`, one developer, and one editing computer
at a time. Use these commands for the branches you actually work on.

**Before editing**

Start with a clean working tree. Replace `my-task` with an existing remote branch
that you want to work on, or use as the starting point for a new branch:

```sh
git fetch origin
git switch my-task
git merge origin/my-task
```

Fetch refreshes your local record of the remote branches. Switch selects the
local branch, creating it with tracking if it exists only on `origin`. Merge
brings the fetched changes into that branch: it fast-forwards when possible
and otherwise attempts a merge. If Git reports conflicts, resolve them, then
run `git add -A` and `git commit` to finish the merge before starting new work.

**To create a new work branch, optionally**

After updating the starting branch above:

```sh
git switch -c my-new-task
```

This creates and selects a local branch. The push below publishes it.

**Checkpoint whenever useful, and always before leaving**

Save your editor's files, then:

```sh
git add -A
git commit -m "Describe the changes"
git push -u origin HEAD
```

Add stages new files, edits, and deletions. Skip add and commit if everything
is already committed. `HEAD` means the current branch here; `-u` establishes
its remote tracking. This push works for both new and existing branches.

Repeat for every branch you worked on. **Every final push must succeed before
switching computers.** Intermediate checkpoints are useful; the last handoff
is essential.

Next session, repeat the start sequence, or use **WipStream: Get from Remote**
in your initialized VS Code clone before editing. The other computer needs
only Git for this workflow.

## When something stops

The normal workflow and recovery commands remain visible in the Command Palette.
If a command cannot run, its message explains the blocking condition. Open
**View → Output → WipStream** for the operation and branch details.

| Situation | What to do |
| --- | --- |
| Git reports an active WipStream merge with conflicts | Edit the files to the desired final contents, then Continue Pending Merge. Use Abort Pending Merge if you want to restore the recorded pre-merge state. |
| You completed the merge in another Git client | Run Commit and Save. WipStream recognizes a verifiable completed merge and closes its stale record while preserving subsequent work. |
| You already aborted the merge in another Git client | If the exact recorded state is restored, Commit and Save or Abort Pending Merge closes the stale record. |
| Git has no active operation but WipStream still reports an incomplete attempt | Run Recover Incomplete Operation, inspect the recorded and current state, and choose Keep Current State if that is the state you want to retain. Then Commit and Save. |
| Git has an unrelated rebase, cherry-pick, or other active operation | Finish or abort it in your Git client first. WipStream will not treat it as its recorded merge. |
| Publication fails or is cancelled | Keep working in the current clone. Address the reported cause; use recovery if an incomplete attempt blocks retry, then Commit and Save again. |
| Initialize reports divergent history | Keep the local checkpoint, reconcile the named branches in your Git tool, then rerun Initialize and choose this machine's work. |
| Remote adoption stops after replacement begins | Keep the displayed backup. Use Recover Incomplete Operation to inspect and keep current state, then rerun Initialize for a fresh choice. Undo cannot restore replaced uncommitted files. |

Continue stages the resolved files and commits the merge, then runs Commit and
Save. Review the resulting file contents before continuing. Abort verifies the
restored state before reporting success; it never resets a completed merge to
try to recreate a missing Git operation.

**Recover Incomplete Operation** preserves current files, staged changes,
untracked files, commits, refs, and recovery history. It closes only the selected
attempt and refuses to run while Git has an active operation or unresolved
index conflicts. It does not publish, undo the attempt, or certify synchronization.
If several attempts are incomplete, inspect and resolve each one.

For interrupted remote adoption, recovery displays the backup location and
offers **Open Backup Folder** afterward. Keeping current state does not restore
that backup. Retry through Initialize, including when replacement stopped with
a detached checkout; do not edit operation receipts or refs manually.

Automatic recognition is conservative. Older receipts record a target branch
name instead of its exact commit; if that history no longer establishes the
outcome, explicit recovery is required. Do not delete receipt files manually.

## Commands at a glance

| Command | Purpose | Shortcut |
| --- | --- | --- |
| Initialize Repository | Choose authoritative work and set up a clone | `Ctrl+W`, then `I` |
| Get from Remote | Retrieve all branches before resuming here | `Ctrl+W`, then `G` |
| Commit and Save | Checkpoint work and synchronize all branches | `Ctrl+W`, then `S` |
| Start Branch | Begin a task from the current branch | Command Palette |
| Finish Branch | Incorporate completed work into its parent | Command Palette |
| Update from Parent | Bring the parent's changes into the work branch | Command Palette |
| Reconcile with Remote | Merge divergent local and remote histories | Command Palette |
| Continue Pending Merge | Commit a resolved merge and save | Command Palette |
| Abort Pending Merge | Abort the recorded merge and verify restoration | Command Palette |
| Recover Incomplete Operation | Inspect a stopped attempt and keep the current state | Command Palette |
| Undo Last Action | Reverse the latest eligible WipStream action | Shown when eligible |
| Condense Branch (Advanced) | Replace branch-only checkpoint history with one commit | Shown on work branches |

## Safety and implementation details

WipStream is intended for one person, multiple separate clones, and one active
editing clone. It is not a team workflow or pull-request manager. Synchronization
uses exact expected commit IDs and atomic remote publication. Finish and Save
refuse unsafe changes to other branches as well as the current one.

Operation receipts and recovery refs live in private Git metadata under `.git`.
They are local to each clone. A recovered operation retains its original history
and is not eligible for Undo; recovery cannot make earlier work unexpectedly
undoable. Ordinary Undo requires the exact recorded state and refuses later
edits, commits, branch changes, or remote changes.

Network operations are cancellable, without a fixed timeout. Cancellation does
not interrupt a local commit or ref transaction. Git state events refresh the
extension's advisory context after external changes; they never trigger a
background commit, merge, fetch, push, recovery, or branch mutation.

## Development and installation

```bash
npm install
npm test
npm run package
```

Packaging does not install or publish anything. When ready, install the packaged
file with **Extensions: Install from VSIX...**, or explicitly run
`code --install-extension dist/lewisl.wipstream-0.2.8.vsix --force`. Install the
same version on each computer used for the workflow.

`npm test` uses disposable local remotes and ordinary clones without contacting
a network service. `npm run test:setup-usage -- --bootstrap` preserves realistic
ordinary clones for workflow exercises and Extension Development Host testing,
without installing an extension. See [setup usage testing](docs/setup-usage-testing.md).
The older `npm run test:live` helper creates a two-clone fixture and VS Code
profile **and installs the VSIX into that profile**; use it only when installation
is intended. Disposable temporary worktrees are permitted for development
guard tests only. Day-to-day extension use still requires exactly one ordinary
worktree per clone.
