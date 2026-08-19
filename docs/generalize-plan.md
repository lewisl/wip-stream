# Generalized change streams

## Purpose

Generalize WipStream from one repository-wide `main -> feature -> wip/feature`
stream into a goals-based interface for any number of named changes, without
making the current one-change-at-a-time workflow harder.

The user should say what they intend to do—start or resume a change, save it,
accept its checkpoints, update it from its target, or finish it—and WipStream
should either complete that intent or leave the repository exactly as it was.
The user should not need to assemble the right sequence of low-level Git
commands and option flags.

## What the current implementation already gives us

`Initialize Stream` already accepts a configurable remote, main branch, feature
branch, and WIP branch. That means distinct branch pairs can already be created
on the same remote. This is a good basis for the generalized design.

Repeated initialization alone is not the complete solution:

- A clone stores only one branch tuple under `wipstream.*`; the most recent
  initialization replaces the previous selection.
- `wipstream.lastKnownRemoteWip` is also singular, so its rewrite lease cannot
  protect several streams independently.
- Save publishes the configured main branch along with the feature and WIP
  branches, coupling otherwise independent streams.
- Topology requires the current remote main to be an ancestor of feature. If
  change A advances main after change B was started, B becomes invalid even
  though its own history and remote handoff are intact.
- Resume and cleanup assume that exactly one temporary branch pair belongs to
  WipStream.

So version 1 supports differently named *sequential* streams, but not several
independent streams that remain understandable and usable while their target
branch moves.

## Findings from existing higher-level approaches

The plan should follow practices that recur across established workflows and
intent-oriented Git tools rather than inventing a private branch theory.

### Practices to adopt

- **One short-lived branch per coherent change.** Pro Git calls these topic
  branches and describes them as work silos that can be completed in an order
  different from the order in which they began. GitHub Flow likewise ends a
  change by merging and deleting its branch. Trunk-Based Development permits
  short-lived change branches but recommends keeping them small and integrating
  them frequently.
- **Record the parent/target relationship explicitly.** Git Town models feature
  branches with parents; Graphite records branch dependencies so its higher-level
  commands can synchronize a stack after a parent moves. This is the semantic
  fact raw Git branch pointers do not retain.
- **Name commands for intent.** Git Town's `hack`, `sync`, and `ship` operations
  start, update, and finish a change. Its ship command refuses a branch that is
  not synchronized and sends the user through sync first. This is preferable to
  a single command silently selecting a merge/rebase/reset strategy.
- **Make recovery a normal command, not expert folklore.** Git Town can undo its
  last command. GitButler snapshots project state before major actions and
  exposes an operations history. Jujutsu records whole-repository operations
  and provides undo/redo instead of asking the user to reconstruct a multi-ref
  change from several reflogs.
- **Preserve stable change identity while commits move.** Jujutsu distinguishes
  a change id from the commit id produced by a particular version of that
  change. WipStream does not need to alter commit objects, but its stream id
  should remain stable while its branch tips advance or its WIP commits are
  condensed.
- **Make conflicts explicit state.** Graphite reports which branches could not
  be restacked. Jujutsu can represent conflicts as data. Git cannot do the
  latter compatibly, so WipStream should either enter a deliberately named
  conflict-resolution workflow or abort cleanly; it must never strand the user
  in an unexplained half-operation.
- **Support preview for compound operations.** Git Town exposes `--dry-run` for
  start, sync, and ship. WipStream should show the selected stream, expected old
  object ids, proposed new tips, pushes, and deletions before high-impact
  operations such as target update, finish, recovery, and undo.
- **Be worktree-aware without requiring worktrees.** Git worktrees are Git's
  native way to check out several branches simultaneously. Repository config
  and normal refs are shared while HEAD and the index are per-worktree. The
  stream registry can therefore be repository-wide while active-stream and
  dirty-state checks must be worktree-specific. The first release can detect
  and respect worktrees without creating or removing them automatically.

### Practices not to copy blindly

- Full GitFlow-style collections of permanent development, release, and
  environment branches solve a different problem and would add policy rather
  than remove it.
- Automatic restacking/rebasing is useful for reviewed stacks, but it rewrites
  several dependent histories and can stop for conflicts. It is not the right
  default for WipStream's first generalized, safety-first release.
- Simultaneously applying several virtual branches to one working directory,
  as GitButler supports, is substantially more stateful than ordinary Git
  checkouts. WipStream can learn from its snapshots and undo without adopting
  its virtual-workspace model.
- Jujutsu's working-copy commits, recorded conflicts, and change-id headers are
  valuable design evidence, but requiring a second VCS would change this
  extension's compatibility promise. WipStream should implement the applicable
  semantics using ordinary Git repositories.

## Proposed model

Separate repository configuration from change-stream configuration.

Repository configuration contains:

- the handoff remote (default `origin`);
- the default target branch (default `main`);
- a configuration schema version.

Each named change stream contains:

- a stable stream id;
- a target branch, such as `main`;
- an accepted branch, such as `generalize`;
- a checkpoint branch, defaulting to `wip/<accepted-branch>`;
- the last remote checkpoint object id observed by this clone.

The accepted and checkpoint branches remain ordinary visible Git branches. The
per-clone registry is only a convenience and safety record; it is not a hidden
source of history. A stream can be attached on another clone by selecting its
two remote branches and confirming its target.

The active stream is derived from the checked-out checkpoint branch whenever
possible. If no stream is active, or more than one choice is possible, the
extension presents a stream picker. There is no repository-wide mutable
“current feature” whose replacement makes other streams inaccessible.

The target is an explicit parent relationship, not necessarily `main`. That
allows a later change to target another accepted change without requiring
stacked-change automation in the first release. WipStream can refuse to finish
a child before its parent rather than guessing how to reorder the stack.

The important topology becomes:

```text
target at start ─── accepted ─── checkpoint
       \
        target may continue independently
```

The invariant that remains continuously true is `accepted` is an ancestor of
`checkpoint`. The target branch is required to be related to the stream, but
its latest tip does not have to remain an ancestor after the stream starts.

## Intent-level commands

Keep the existing commands working and introduce clearer generalized names in
the UI. During migration, old command ids can delegate to the new operations.

1. **Initialize WipStream Repository**
   Validates the repository, remote, and atomic-push capability once. It does
   not create a change unless the user continues into Start or Attach.

2. **Start or Attach Change**
   Starts a named accepted/checkpoint pair from a selected target, or attaches
   to a matching pair already on the remote. The defaults `feature` and
   `wip/feature` preserve today's simplest path.

3. **Open Change / Get Current**
   Selects a stream when necessary, refuses local work it cannot account for,
   fetches, fast-forwards only recognized local stream refs, and checks out the
   checkpoint branch.

4. **Save Change to Remote**
   Saves documents, creates a checkpoint when needed, and publishes only that
   stream's accepted and checkpoint refs. It does not republish the target.

5. **Accept Checkpoints**
   Advances the accepted branch to the checkpoint branch and atomically
   publishes the stream pair. This is today's To Feature operation.

6. **Update Change from Target**
   Makes an explicit attempt to incorporate a target that advanced after the
   stream started. The first implementation should use a merge, not a rebase:
   successful history remains visible, no force-push is needed, and failure can
   be aborted back to the exact starting state. Require all checkpoints to be
   accepted first. If the merge conflicts, abort automatically and report that
   no refs were changed; conflict-resolution workflow can be designed as a
   separate, explicit feature.

7. **Finish Change**
   Requires accepted and checkpoint to match and the target to be an ancestor
   of accepted. It then fast-forwards the target, atomically publishes the
   target update and deletion of only this stream's remote branches, and removes
   only this stream's local branches. If the target moved, it directs the user
   to Update Change from Target rather than starting an implicit rebase or
   leaving a conflict in progress.

8. **Inspect / Recover Change**
   Shows the target, accepted, checkpoint, local/remote relation, and exact
   reason a command is refusing to proceed. Where preservation is required, it
   offers an explicitly named rescue branch before any retry.

9. **Preview / Undo WipStream Operation**
   Preview shows the fully resolved intent without changing anything. Undo uses
   the durable receipt for the last WipStream operation, verifies that every
   affected local and remote ref still has the value produced by that operation,
   and restores the previous values only when those leases still match. If any
   value changed later, Undo refuses and offers recovery rather than erasing the
   later work.

For a user who has only one active change, Start, Get Current, Save, Accept, and
Finish remain one-choice commands with the same defaults and keyboard-driven
flow as today.

## Safety contract

Every mutating command must uphold these invariants:

1. Start only from a stable repository: no unresolved Git operation, conflicts,
   dirty submodule, or unsaved/dirty work that the command did not explicitly
   promise to checkpoint.
2. Fetch immediately before decisions that depend on remote state.
3. Identify every ref by a fully resolved branch name and record its starting
   object id before moving it.
4. Protect remote replacement or deletion with an exact expected-object lease.
   Do not use an unqualified force push.
5. Move related local refs with `git update-ref --stdin` transactions, including
   expected old object ids. Do not implement a multi-ref intent as independent
   `git branch -f` calls.
6. Publish related remote changes atomically. A remote either sees the complete
   intent or none of it.
7. Write a durable, human-readable operation receipt before the first mutation.
   It records the intent, worktree, selected stream, old refs, proposed refs,
   remote expectations, and completion state. Protect pre-operation objects with
   plainly named local recovery refs until the receipt expires or is dismissed.
8. Never move or delete a ref containing an unrecognized commit. Stop and name
   the ref and commit that need preservation.
9. Do not leave the user detached or in the middle of merge, rebase, cherry-pick,
   or another Git operation. On a failed higher-level operation, abort and
   verify restoration before reporting failure.
10. Scope save, resume, rewrite leases, finish, and cleanup to one selected
   stream. Another stream on the same remote must be untouched.
11. Treat the remote checkpoint branch as the handoff authority, while treating
   local-only work as data to preserve rather than state to overwrite.
12. Serialize WipStream mutations with a repository-level lock while performing
    worktree-specific dirtiness and HEAD checks. Refuse a stream whose checkpoint
    branch is already checked out in another worktree rather than bypassing Git's
    safeguard.
13. Report the completed intent in ordinary language, including the stream and
    branch names involved. Error messages state both what was detected and the
    safe next action.

## Configuration and migration

Introduce configuration schema version 2 with repository defaults plus
stream-keyed entries. Do not silently reinterpret a version 1 clone.

Migration behavior:

- Detect the existing version 1 tuple.
- Validate its local and remote topology with the version 1 rules before
  writing anything.
- Create one version 2 stream record with the same branch names and copy the
  last-known remote WIP object id into that stream.
- Preserve the existing `wipstream:init`, `resume`, `saveup`, `tofeature`, and
  `tomain` command ids as compatibility aliases for at least the first version
  2 release.
- If validation cannot prove the conversion safe, make no configuration or ref
  changes and explain the conflicting state.

Prefer readable Git config sections for the local registry. Before settling the
exact key encoding, prototype names containing slashes, dots, spaces, case
differences, and Unicode. Stream ids must not be interpolated into config keys
or ref names without one centralized validation/encoding function.

## Implementation plan

### Phase 1: Specify behavior before refactoring

- Write a state table for each intent across clean, dirty, missing, behind,
  ahead, diverged, target-advanced, remote-deleted, and operation-in-progress
  states.
- Turn the safety contract above into named test assertions.
- Decide the precise version 2 config key format and stream discovery rules.
- Specify the operation-receipt format, recovery-ref namespace, retention, and
  lease rules for local-only and remotely published undo.
- Record the minimum supported Git version for the merge/abort and atomic-push
  behavior on macOS, Windows, and Linux.

Exit criterion: every recognized state has one deterministic action or refusal;
no row says “repair manually” without identifying what must be preserved.

### Phase 2: Extract stream-scoped domain operations

- Split repository settings from `StreamConfig`.
- Add a stream registry keyed by stable id and make the WIP rewrite lease
  stream-specific.
- Replace helpers that implicitly iterate main/feature/WIP with helpers that
  accept an explicit stream and an explicit set of refs.
- Add exact local-ref snapshots, transactional `update-ref` support, durable
  operation receipts, and reusable remote lease construction.
- Add repository locking and worktree enumeration so one worktree cannot move a
  branch checked out by another.
- Keep the existing lifecycle passing through a compatibility adapter.

Exit criterion: existing tests pass unchanged, while two stream objects can be
loaded in one clone without overwriting each other's configuration.

### Phase 3: Make handoff independent of a moving target

- Change Save and Get Current to fetch the target for visibility but update and
  publish only the selected accepted/checkpoint pair.
- Relax topology validation from `latest target -> accepted -> checkpoint` to
  the generalized stream invariants.
- Ensure completion of one stream does not make another stream unopenable or
  unsaveable.
- Apply WIP-rewrite confirmation and lease checks independently per stream.

Exit criterion: two clones can exchange stream B after stream A has advanced
`main`, with no force, reset, or manual ref repair.

### Phase 4: Add target update and generalized finish

- Add the explicit Update Change from Target operation.
- Snapshot relevant refs, attempt the merge from a clean state, and automatically
  abort and verify the snapshot on conflict or hook failure.
- On success, atomically publish the updated accepted/checkpoint pair.
- Generalize Finish so it fast-forwards the selected target and deletes only the
  selected stream under exact leases.
- Make retries idempotent after every possible interruption point.

Exit criterion: target-unchanged finish is as simple as today; target-advanced
finish is Update then Finish; a failed update leaves no Git operation or changed
ref behind.

### Phase 5: Expose the model in VS Code

- Add stream selection and Start/Attach prompts with good one-stream defaults.
- Show the active stream and target in every success/error record.
- Add Inspect / Recover output suitable for copying into a bug report.
- Add operation history, Preview, and lease-checked Undo commands.
- Show other worktrees that currently own a selected stream and provide an Open
  Workspace action; defer automatic worktree creation/removal until it can be
  designed and tested separately.
- Retain existing keybindings where their intent is unchanged; assign new keys
  only after testing chord conflicts.
- Update README diagrams, command documentation, recovery instructions, and
  live-test guidance.

Exit criterion: the single-stream path takes no more choices than version 1,
while multiple streams never require editing Git config or typing branch-moving
commands.

### Phase 6: Compatibility, failure injection, and release

- Test migration from an active version 1 stream, a completed stream, and a
  stale second clone.
- Inject failures before and after commit, fetch, local ref movement, atomic
  push, merge, remote deletion, and local cleanup.
- Run automated tests on Windows, macOS, and Linux Git.
- Run the isolated two-window live test with one simple stream, then with two
  streams sharing a target.
- Package a prerelease VSIX and keep schema rollback instructions with it.

Exit criterion: every injected failure has a documented retry or recovery path,
and no test ends with lost commits, an active Git operation, or an unexplained
ref.

## Required acceptance scenarios

- The current default `main`, `feature`, `wip/feature` lifecycle remains fully
  compatible and no more complicated.
- Two named streams can coexist in one clone and on one remote.
- Each stream can be used from two different clones.
- Saving stream A never pushes, moves, or deletes stream B or the target branch.
- Completing A may advance `main`; B can still resume and save afterward.
- B can explicitly update from the advanced `main`, then finish.
- A stale clone cannot replace a newer remote checkpoint, including after a
  local WIP history rewrite.
- Concurrent attempts to create the same stream produce one winner and one
  clean, understandable refusal.
- Finishing or cleaning an already-finished stream is retry-safe.
- A conflicting target update restores the exact pre-command branch, index,
  worktree, and operation state.
- Preview makes no filesystem, config, ref, or remote change.
- Undo restores a completed operation when all after-state leases match and
  refuses without mutation when any later local or remote change exists.
- An interrupted command leaves a receipt and recovery refs that Inspect can
  explain and either resume, roll back, or preserve.
- Branch names with slashes and other supported characters do not collide in
  config or stream discovery.
- Unrelated ordinary Git branches are never treated as owned by WipStream.
- Streams checked out in different Git worktrees remain isolated; a command in
  one worktree cannot switch or move the active branch of another.

## Deliberate non-goals for the first generalized release

- Concurrent editing of the same stream by two machines. The remote lease still
  enforces one active writer per stream.
- Team review, permissions, pull requests, or issue tracking.
- Automatic conflict resolution.
- Hidden rebases or automatic history rewriting when the target advances.
- Background fetching, committing, or pushing.
- Managing repositories outside the selected VS Code workspace.

## First implementation slice

Start with the smallest architectural proof: version 2 in-memory stream objects,
stream-keyed leases, and a test with two streams where completing A advances
`main` and B can still resume and save. Keep the UI and command ids unchanged in
that slice. This proves the central generalization before committing to the
picker and command-surface work.

## Research sources

- [Pro Git: Branching Workflows](https://git-scm.com/book/en/v2/Git-Branching-Branching-Workflows)
- [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)
- [Trunk-Based Development: Short-Lived Feature Branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/)
- [Git Town: hack](https://www.git-town.com/commands/hack),
  [sync](https://www.git-town.com/commands/sync),
  [ship](https://www.git-town.com/commands/ship), and
  [undo](https://www.git-town.com/commands/undo)
- [Graphite: CLI concepts](https://graphite.com/docs/cli-tutorials) and
  [restacking branches](https://graphite.com/docs/restack-branches)
- [GitButler: Operations History](https://docs.gitbutler.com/features/timeline)
- [Jujutsu: comparison with Git](https://docs.jj-vcs.dev/latest/git-comparison/),
  [bookmarks and push safety](https://docs.jj-vcs.dev/latest/bookmarks/), and
  [working copies/workspaces](https://docs.jj-vcs.dev/latest/working-copy/)
- [Git worktree](https://git-scm.com/docs/git-worktree),
  [update-ref transactions](https://git-scm.com/docs/git-update-ref),
  [atomic push and force-with-lease](https://git-scm.com/docs/git-push), and
  [merge abort safety](https://git-scm.com/docs/git-merge)
