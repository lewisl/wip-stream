# WipStream generalization: all branches, one working directory

> Historical design record: version 1 migration and the temporary legacy
> command handlers described below shipped in 0.2.0–0.2.1 and were retired in
> 0.2.2 after the known repositories were migrated.

## Summary

Replace the fixed `main -> feature -> wip/feature` model with ordinary Git
branches synchronized as one repository-wide set.

The governing rule is:

> One clone has one worktree, one working directory, one index, and one
> checked-out branch. Independent work uses branches. Concurrent workers or
> agents use separate clones and branches.

Normal WipStream usage remains only three commands:

1. **Initialize Repository** — once per clone.
2. **Get from Remote** — before starting or resuming work.
3. **Commit and Save** — when checkpointing or handing work off.

Optional lifecycle conveniences are secondary:

- **Start Branch**
- **Finish Branch**

All other actions are contextual or exceptional:

- **Update from Parent** appears when a branch's parent advanced.
- **Reconcile Branch with Remote** appears only after same-branch divergence.
- **Continue** and **Abort** appear only during guided conflict resolution.
- **Undo** is a recovery action.
- **Condense Branch** is an advanced optional action.

WipStream will not add a general branch-deletion or Abandon command.

## Branch and command model

### Repository state

- Synchronize every ordinary local and remote `refs/heads/*` branch.
- Treat every local branch as publishable; there is no WipStream-managed or
  private subset.
- Commit files only from the one checked-out branch and working directory.
- Permit direct work on the remote default branch.
- Do not manage tags, pull requests, releases, or deployment branches.
- Store the schema version and selected remote in Git config.
- Store optional local parent intent as
  `branch.<name>.wipstreamParent`.
- For a branch without recorded parent intent, assume the remote default branch
  for advisory status. Confirm and persist the parent before Update, Finish, or
  Condense.

### Commands

| Command | Required behavior |
| --- | --- |
| **Initialize Repository** | Validate the repository and remote, migrate version 1 when needed, safely reconcile all branches in both directions, and check out the remote default branch. |
| **Get from Remote** | Fetch every branch and apply an all-or-nothing local update. Preserve the previously checked-out branch unless it was safely deleted remotely. |
| **Commit and Save** | Save buffers, checkpoint the current working directory, retrieve unrelated safe remote advances, and atomically publish every local branch advance. |
| **Start Branch** | Create and check out an ordinary branch from the current branch, record that parent, and carry existing uncommitted files without automatically committing them. |
| **Finish Branch** | Ensure the branch is saved and current with its parent, fast-forward the parent to it, and ask whether to retain or delete the completed branch. |
| **Update from Parent** | Merge the selected parent into the current branch; never perform a hidden rebase. |
| **Reconcile with Remote** | Merge the fetched remote version of the current branch after two clones changed that branch independently. |
| **Condense Branch** | Explicitly replace checkpoint history with one commit after confirming the parent and synchronized state. |
| **Undo Last Action** | Restore the most recent compound WipStream action only when no later local or remote work would be overwritten. |

Retain the existing `init`, `resume`, and `saveup` command ids with the new
display names. Add ids for lifecycle and recovery actions, but expose them
according to context:

- Init, Get, and Commit and Save remain the primary commands and retain their
  keybindings.
- Start and Finish are ordinary Command Palette conveniences.
- Update is offered in the parent-status message and when Finish requires it.
- Reconcile is offered only after detected divergence.
- Continue and Abort are available only while a WipStream merge is pending.
- Undo is available only when the latest operation is safely undoable.
- Condense is marked advanced and receives no default keybinding.
- Retain legacy `tofeature` and `tomain` handlers for one compatibility
  release. `tomain` delegates to Finish after migration; `tofeature`
  explains the removed accepted/WIP distinction and performs no implicit
  rewrite.

### Parent-change awareness

WipStream has no background activity, so it discovers parent changes when Init,
Get, Commit and Save, Update, or Finish contacts the remote.

After successful Get or Commit and Save, compare each branch with its known or
assumed parent:

- Parent is an ancestor of branch: the branch already contains the latest
  parent.
- Branch is an ancestor of parent: the branch was probably integrated already.
- Neither is an ancestor: the parent advanced independently and Update is
  required before Finish.

Report this as a non-blocking advisory:

> `feature` is synchronized with the remote, but parent `main` has advanced
> by 2 commits. You may continue working. Update from Parent is required before
> Finish.

This supports one user moving among machines and branches. It also safely
accommodates outside contributors without turning WipStream into a team
workflow.

## Implementation design

### Enforce the one-worktree boundary

- Require a complete, non-bare, non-shallow clone.
- Run `git worktree list --porcelain` at the beginning of every mutating
  command and immediately before ref or remote mutation.
- Refuse if more than one worktree exists and list every path and checked-out
  branch.
- Never create, prune, repair, open, or remove worktrees.
- Serialize WipStream commands with a repository-local lock.
- Document that external Git processes do not honor this lock; the clone
  requires exclusive access while a WipStream command runs.
- Recommend separate clones and separate branches for concurrent agents.

### Build one branch-reconciliation engine

Before fetching, record local heads, remote-tracking heads, the checked-out
branch, index state, and worktree state. After fetching and pruning, classify
each branch:

- **Equal:** no change.
- **Local ahead:** publish during Init or Commit and Save; block Get.
- **Local-only:** publish during Init or Commit and Save; block Get.
- **Remote ahead:** fast-forward the local branch.
- **Remote-only:** create a local tracking branch.
- **Diverged:** refuse automatic reconciliation.
- **Remotely deleted:** remove the local counterpart only when it exactly
  matched the previously observed remote tip. Preserve a recovery ref. If it
  changed locally, refuse.

Transactional Get means:

- Preflight the entire branch set before moving an ordinary local branch.
- If any branch is unsafe, move no local heads and do not change the working
  tree.
- Fetch may still update remote-tracking observations.
- If every branch is safe, apply the full local plan.
- Preserve the current checkout unless its branch was safely deleted. In that
  case, switch to its surviving recorded parent or the remote default branch.

Init and Commit and Save perform bidirectional reconciliation:

1. Create any required local checkpoint and operation receipt.
2. Fetch and classify the complete branch set.
3. Refuse true divergence or ambiguous deletion.
4. Atomically push every local-ahead or local-only branch with exact
   expected-object leases.
5. Apply remote-ahead, remote-only, and safe-deletion changes through
   expected-old-value local ref transactions.
6. Update the current working tree when its checked-out branch advanced.
7. Report success only after all ordinary local and remote branch names and tips
   match.

Git cannot atomically mutate the remote, local refs, and working tree in one
primitive. Therefore:

- Treat the atomic remote push as the publication commit point.
- Record every phase in the operation receipt.
- If publication succeeds but a later local phase fails, report the operation
  as incomplete and the remote as authoritative.
- Make retry and lease-checked Undo available.
- Never describe a partial operation as successful.

### Implement checkpointing, lifecycle, and conflicts

Commit and Save must:

- Save file-backed VS Code documents in the selected repository.
- Reject pre-existing Git operations, unresolved conflicts, dirty submodules,
  and additional worktrees.
- Stage all non-ignored additions, modifications, and deletions.
- Prompt for a checkpoint message only when a commit will be created.
- Create the local checkpoint before remote reconciliation so offline or
  divergent work remains protected.
- Honor Git commit hooks.
- On same-branch divergence, push nothing remotely, retain the local
  checkpoint, and offer Reconcile.

Update and Reconcile must:

- Start from a saved, stable branch.
- Create a recovery snapshot before merging.
- Use merge rather than rebase.
- On a clean merge, create the merge commit and run Commit and Save.
- On conflict, record an explicit pending WipStream operation, list unresolved
  files, and expose Continue and Abort.
- Block unrelated WipStream mutations while resolution is pending.
- Continue only after all conflicts are resolved.
- Abort through Git's merge-abort mechanism, then verify the branch, index, and
  working tree against the saved pre-merge state.

Finish must:

- Save and synchronize the current branch first.
- Confirm its recorded or selected parent.
- Refuse if the latest parent is not an ancestor and offer Update from Parent.
- Fast-forward the parent to the branch tip.
- Ask every time whether to retain or delete the completed branch.
- Publish the parent update and optional branch deletion atomically under exact
  leases.
- Switch the local checkout to the parent and mirror the chosen
  branch-retention result.

Checkpoint commits remain permanent by default. Condense is always separate,
explicit, previewed, lease-protected, and undoable.

### Add operation history and safe Undo

- Represent every compound mutation as a calculated plan followed by apply
  phases.
- Show affected branches, expected old tips, proposed tips, checkout changes,
  and deletions before destructive or rewriting actions.
- Store human-readable operation receipts in private Git metadata, never
  tracked project files.
- Protect pre-operation commits using internal refs outside
  `refs/heads/*`.
- Retain incomplete operations until resolved; retain completed recovery points
  for a documented bounded period.
- Undo only the latest completed WipStream mutation.
- Require a clean worktree and exact recorded after-state locally and remotely.
- Refuse Undo without mutation if later work exists.
- Use atomic leased pushes remotely and expected-old-value transactions locally.
- When undoing Commit and Save, restore the previous branch tip and return
  checkpointed content to the working directory.

## Version 1 migration

For the configured version 1 main, feature, and WIP branch names:

- Require complete, synchronized local and remote topology with
  `main -> feature -> WIP`.
- Advance the ordinary feature branch to the WIP tip, preserving every
  checkpoint commit.
- Atomically update remote feature and delete remote WIP.
- Transactionally update local feature and remove local WIP.
- Record main as feature's parent.
- If temporary branches are already absent because the feature completed,
  initialize version 2 normally.
- Refuse partial, divergent, or unrecognized topology without changing refs or
  configuration.
- Make migration previewable and undoable.
- Write schema version 2 only after migration and reconciliation succeed.

## Assumptions and defaults

- The expected user is one person using several machines, with one active
  editing clone at a time.
- Other people or automated systems may advance remote branches; WipStream
  detects rather than overwrites their work.
- The configured remote is the authoritative handoff location for every
  ordinary branch after a successful operation.
- Normal operation requires only Init, Get, and Commit and Save.
- Branch lifecycle commands are optional conveniences, not synchronization
  prerequisites.
- The remote default branch is the assumed parent when no local parent intent
  exists.
- Parent updates use merge; no hidden rebase or automatic force-push is allowed.
- Checkpoint history is preserved unless Condense is explicitly invoked.
- Finish asks whether to retain or delete the branch.
- Multiple worktrees are unsupported and block mutation.
- Parallel agents use separate clones and branches.
- WipStream performs no background fetch, commit, push, merge, or filesystem
  synchronization.
