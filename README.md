# WipStream

WipStream is a VS Code extension for one person who works on a Git repository
from more than one computer. It provides goal-oriented commands for safe Git
handoff without hiding branch state or inventing a parallel revision system.

WipStream is currently distributed as a `.vsix`; it is not published on the
VS Code Marketplace.

## The model

WipStream supports every ordinary Git branch. A typical repository might look
like this:

```text
main ────────────────●──────────────●
  ├─ change/search ──●──●
  └─ change/export ──●────●
```

There are no managed WIP companion branches. The checked-out branch is the
branch being edited, and **Commit and Save** checkpoints that branch while also
reconciling every other safe local or remote branch.

WipStream assumes one person, several separate clones, and one active editing
clone at a time. It detects remote changes made by another person or tool, but
it is not a team workflow, pull-request manager, or deployment system.

## Normal use: three commands

### Initialize Repository (`wipstream.init`)

Run this once in each clone. Initialize validates a complete non-bare clone,
the selected remote and its default branch, full branch fetch coverage, atomic
push support, a clean working tree, and exactly one worktree. It then safely
reconciles every ordinary local and remote branch in both directions and checks
out the remote default branch.

### Get from Remote (`wipstream.resume`)

Run this before editing when returning to a clone. Get fetches and prunes every
remote branch, then applies all safe local updates as one expected-state
transaction. It preserves the current checkout unless that branch was safely
deleted remotely, in which case it selects the recorded parent or remote
default branch.

Get refuses local-only commits, local advances, divergence, ambiguous deletion,
dirty files, conflicts, active Git operations, or additional worktrees. A
refusal may refresh remote-tracking refs, but it does not move an ordinary local
branch or replace working files.

### Commit and Save (`wipstream.saveup`)

Run this to hand work to the remote:

1. Save file-backed VS Code documents in the selected repository.
2. Stage all non-ignored additions, modifications, and deletions.
3. If content changed, ask for a checkpoint message and commit it on the
   checked-out branch.
4. Fetch and classify every branch.
5. Atomically publish all safe local advances with exact leases and apply safe,
   unrelated remote advances locally.

A successful result means every ordinary local branch name and tip equals the
remote. An unsuccessful handoff retains the local checkpoint and explicitly
warns not to resume from another clone. Git commit hooks are honored, and dirty
submodules are refused.

Commands that may contact the remote show a cancellable progress notification.
Cancellation stops only the active fetch or push; it never interrupts a local
commit, checkout, configuration change, or ref transaction. If journaling has
already begun, WipStream keeps the operation receipt incomplete and requires it
to be inspected before another mutation. There is no fixed network timeout.

## A multi-computer session

1. On computer A, run **Get from Remote**, edit, then run **Commit and Save**.
2. Wait for the successful remote-handoff message.
3. On computer B, run **Get from Remote** before editing.
4. Check out the branch you intend to continue using VS Code's normal Git
   branch picker if it is not already checked out.
5. Edit and run **Commit and Save** again.

Several branches may exist and be consulted in the clone, but only the one
checked-out branch supplies the working directory being edited.

Switching computers never requires **Finish Branch**. After Commit and Save
reports a successful handoff, the second computer may close VS Code; the first
computer can later Get from Remote and continue the same branch with those
changes intact. Finish is only for deliberately completing the branch into its
parent.

## Optional branch lifecycle

- **Start Branch** creates a normal branch from the current branch, records
  that parent intent, and carries existing uncommitted files without committing
  them.
- **Update from Parent** retrieves current remote state and merges the recorded
  or confirmed parent. It never performs a hidden rebase.
- **Finish Branch** first saves, verifies ancestry, fast-forwards the parent,
  and asks whether to retain or delete the completed branch.
- **Condense Branch (Advanced)** explicitly replaces two or more
  branch-exclusive checkpoint commits with one tree-equivalent commit after a
  preview and confirmation. It has no default keybinding.

Parent changes discovered during Get or Save are advisories. Work can continue;
Update is required only before an ancestry-dependent action such as Finish when
the parent advanced independently.

## Conflict recovery and Undo

**Reconcile with Remote** is offered only when the checked-out branch has true
local/remote divergence. It merges the fetched remote tip into the local
checkpointed branch. If Reconcile or Update conflicts, WipStream records the
paths and exposes only **Continue Pending Merge** and **Abort Pending Merge**.
Abort verifies the complete restored branch, index, worktree, and Git-operation
state before claiming success.

**Undo Last Action** is shown only for the latest eligible WipStream operation.
It requires a clean single worktree and the exact recorded local,
configuration, checkout, and remote after-state. It reverses remote refs with
exact leases and local refs transactionally. Any later edit, commit, branch
move, or remote change blocks Undo rather than guessing.

Human-readable receipts and recovery refs live in private Git metadata under
`.git`; they are never tracked project files.

## One-worktree rule

WipStream supports multiple separate clones and rejects repositories with
linked Git worktrees. It never runs `git worktree add`, `move`, `repair`,
`prune`, `unlock`, or `remove`.

Use a separate ordinary branch for separate work. Only one branch is checked
out in a clone at a time. This keeps the working directory, index, checkout,
and command receipts in one comprehensible state. AI agents working in this
repository must follow the same rule: create or use a branch in the existing
clone, never create a second worktree as a sandbox.

## Commands and keyboard shortcuts

The normal commands keep their original IDs and chords:

| Command | ID | Key |
| --- | --- | --- |
| Initialize Repository | `wipstream.init` | `Ctrl+W`, then `I` |
| Get from Remote | `wipstream.resume` | `Ctrl+W`, then `G` |
| Commit and Save | `wipstream.saveup` | `Ctrl+W`, then `S` |

Start and Finish are ordinary Command Palette actions. Update, Reconcile,
Continue, Abort, and Undo appear only when relevant. Condense is advanced and
has no default chord.

## Prerequisites

- A normal, complete Git clone with a reachable remote (default `origin`).
- A remote with a valid symbolic default branch and atomic-push support.
- Permission to create, update, and delete ordinary branches.
- Exactly one worktree for the repository.

Files excluded by `.gitignore` and empty directories are not committed.

## Install from a VSIX

Download the `.vsix`, run **Extensions: Install from VSIX...** from the Command
Palette, and select the file. Or use:

```bash
code --install-extension /path/to/lewisl.wipstream-<version>.vsix
```

## Development

```bash
npm install
npm test
npm run package
code --install-extension dist/lewisl.wipstream-0.2.5.vsix --force
```

`npm test` uses disposable local bare remotes and clones; it never contacts a
network service. `npm run test:live` packages the extension, creates an isolated
two-clone fixture and VS Code profile, and prints verification and cleanup
commands.

Every command writes its operation id, affected branches, result, and safe next
action to the **WipStream** Output channel. The extension has no background
commit, merge, pull, push, or branch mutation.
