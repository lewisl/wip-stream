# Generalize implementation checklist

This checklist implements `docs/generalize-plan.md`. Complete phases in order.
Do not begin a later phase while an earlier exit gate is failing. Keep the
normal interface centered on Initialize Repository, Get from Remote, and Commit
and Save.

## Phase 0: Preserve the version 1 baseline

- [x] Run and record the current automated workflow test result before changing
  source.
- [x] Add missing characterization tests for every current command result and
  failure code that migration or compatibility code will depend on.
- [x] Capture fixtures for an active stream, a completed stream, a stale clone,
  a WIP rewrite, partial temporary branches, and divergent temporary branches.
- [x] Confirm existing commit-hook, dirty-submodule, cancelled-message,
  untracked-file, and two-clone behaviors remain represented.

Exit gate:

- [x] The unchanged version 1 implementation passes all characterization tests.
- [x] Every existing public command id has an explicit compatibility expectation.

## Phase 1: Introduce the version 2 repository model

- [x] Replace the fixed main/feature/WIP configuration type with repository
  configuration containing schema version and selected remote.
- [x] Add helpers for reading and writing local
  `branch.<name>.wipstreamParent` intent.
- [x] Define the ordinary branch universe as local and remote
  `refs/heads/*`, excluding internal WipStream recovery refs.
- [x] Resolve and validate the remote default branch through its symbolic HEAD.
- [x] Add branch inventory types containing local tip, previous remote tip,
  fetched remote tip, tracking state, checked-out state, and relation.
- [x] Add deterministic classification for equal, local-ahead, local-only,
  remote-ahead, remote-only, diverged, and remotely deleted branches.
- [x] Keep version 1 configuration readable without converting it yet.

Tests:

- [x] Inventory covers multiple branches, slash-containing names, local-only
  branches, remote-only branches, force-rewritten branches, and remote deletion.
- [x] Missing or ambiguous remote HEAD produces an actionable refusal.
- [x] Tags and internal refs never enter the ordinary branch inventory.

Exit gate:

- [x] The new model can inspect version 1 and version 2 repositories without
  moving refs or changing configuration.

## Phase 2: Enforce one clone and one worktree

- [x] Add structured `git worktree list --porcelain` parsing to the Git facade.
- [x] Require exactly one worktree at the start of every mutating workflow.
- [x] Recheck immediately before every local-ref transaction and remote push.
- [x] Report every additional worktree path, HEAD, and checked-out branch.
- [x] Add a repository-local WipStream command lock with stale-lock diagnostics.
- [x] Ensure WipStream never invokes worktree add, move, repair, prune, unlock,
  or remove.

Tests:

- [x] A clean linked worktree blocks mutation.
- [x] A dirty linked worktree blocks mutation without inspecting or modifying
  its files.
- [x] A linked worktree injected after initial preflight is caught by the final
  pre-mutation check.
- [x] Two separate clones remain supported.
- [x] Concurrent WipStream commands in one clone serialize or refuse cleanly.

Exit gate:

- [x] No mutating workflow can proceed while a linked worktree is known to
  exist.

## Phase 3: Build plans, local ref transactions, and receipts

- [x] Represent each compound action as an immutable operation plan with
  expected old refs, proposed refs, remote leases, checkout before/after, and
  destructive effects.
- [x] Add expected-old-value multi-ref updates using
  `git update-ref --stdin`.
- [x] Define the private operation-receipt directory and JSON schema.
- [x] Define internal recovery refs using operation ids and ordinal ref names so
  arbitrary branch names cannot collide.
- [x] Record operation phases before and after every mutation boundary.
- [x] Add repository inspection for incomplete operations.
- [x] Define bounded completed-receipt retention while retaining incomplete
  operations until resolved.
- [x] Add preview rendering shared by the Output channel and confirmations.

Tests:

- [x] A mismatched expected local ref aborts the whole local ref transaction.
- [x] Receipts survive interruption after every operation phase.
- [x] Recovery refs keep rewritten or deleted commits reachable.
- [x] Preview changes no project file, ordinary ref, config value, or remote ref.

Exit gate:

- [x] A simulated interruption always yields either the complete before-state,
  the complete after-state, or an inspectable incomplete receipt with all data
  needed to retry or undo.

## Phase 4: Implement transactional Get from Remote

- [x] Save the current branch name and pre-fetch local/remote-tracking inventory.
- [x] Require a stable, clean single worktree.
- [x] Fetch and prune every branch from the configured remote.
- [x] Treat local-ahead, local-only, diverged, and ambiguous deletion as unsafe
  for Get.
- [x] Prove a remote deletion safe only when local tip equals the pre-fetch
  remote-tracking tip.
- [x] Preflight every branch before moving any ordinary local ref.
- [x] Create remote-only local branches and configure their tracking relation.
- [x] Fast-forward remote-ahead local branches.
- [x] Delete only proven-safe stale local branches while retaining recovery refs.
- [x] Preserve the prior checkout; if it was safely deleted, select its surviving
  recorded parent or the remote default.
- [x] Verify local branch names and tips equal fetched remote branch names and
  tips before reporting success.
- [x] Emit non-blocking parent ancestry advisories after success.

Tests:

- [x] Several safe branches update together.
- [x] One unsafe branch prevents every ordinary local branch and working-tree
  update.
- [x] Fetch may update remote-tracking refs on refusal, but ordinary refs remain
  unchanged.
- [x] Current-branch fast-forward updates files correctly.
- [x] Safe deletion of the current branch selects the required fallback.
- [x] Repeating a successful or refused Get is idempotent.

Exit gate:

- [x] Successful Get establishes complete local/remote branch parity.
- [x] Refused Get preserves all ordinary local refs and the working tree.

## Phase 5: Implement bidirectional Initialize Repository

- [x] Validate full clone, non-bare state, remote reachability, remote default
  branch, full branch fetch coverage, and atomic-push capability.
- [x] Require a clean, stable, single worktree before bootstrap.
- [x] Plan local-ahead/local-only publication and remote-ahead/remote-only local
  updates across the whole branch set.
- [x] Refuse any same-branch divergence or ambiguous deletion before mutation.
- [x] Push all local advances atomically with exact leases.
- [x] Apply fetched local changes through the shared local transaction engine.
- [x] Check out the remote default branch after successful first initialization.
- [x] Write version 2 configuration only after branch reconciliation succeeds.

Tests:

- [x] Fresh clone with several remote branches initializes completely.
- [x] Existing repository with unrelated local and remote advances reconciles in
  both directions.
- [x] Local-only branches are published.
- [x] True divergence changes neither ordinary local nor remote refs.
- [x] Remote success followed by injected local failure produces an incomplete
  receipt and a retryable remote-authoritative state.

Exit gate:

- [x] Successful Init establishes version 2 configuration and complete branch
  parity with the remote default checked out.

## Phase 6: Implement Commit and Save

- [x] Save file-backed VS Code documents belonging to the selected repository.
- [x] Reject pre-existing Git operations, unresolved conflicts, dirty
  submodules, and additional worktrees.
- [x] Stage all non-ignored additions, modifications, and deletions.
- [x] Prompt for a checkpoint message only when staged content exists.
- [x] Create the current-branch checkpoint before network reconciliation.
- [x] Preserve staged work when a commit hook rejects the checkpoint.
- [x] Fetch and classify all branches after checkpointing.
- [x] On true divergence, push nothing, retain the local checkpoint, and return
  a result that offers Reconcile for current-branch divergence.
- [x] Atomically publish all local-ahead and local-only branches with exact
  leases.
- [x] Apply unrelated safe remote advances locally.
- [x] Verify complete branch parity before reporting a successful handoff.
- [x] Emit parent ancestry advisories without blocking continued work.

Tests:

- [x] One Save publishes committed work accumulated on several branches.
- [x] Save can publish local work on one branch while retrieving an unrelated
  remote advance on another.
- [x] Offline Save retains a local checkpoint and reports that handoff did not
  occur.
- [x] A remote race rejects the complete atomic push.
- [x] Same-branch divergence retains the checkpoint and changes no remote ref.
- [x] Direct work on the remote default branch is supported.

Exit gate:

- [x] Successful Commit and Save means every ordinary local and remote branch
  name and tip matches.
- [x] Every unsuccessful remote handoff explicitly says that another clone must
  not resume from the remote yet.

## Phase 7: Add parent intent and optional lifecycle commands

- [x] Implement Start Branch from the current branch and record that parent.
- [x] Carry existing uncommitted files safely to a newly created branch.
- [x] For imported branches, assume remote default for advisory status and
  confirm/persist parent intent before a parent-dependent mutation.
- [x] Implement the three ancestry states: current with parent, probably already
  integrated, and parent advanced independently.
- [x] Implement Update from Parent using merge, never hidden rebase.
- [x] Implement Finish as Save, fetch/recheck, ancestry validation,
  parent fast-forward, and a retain/delete prompt.
- [x] Publish Finish parent update and optional deletion atomically with exact
  leases.
- [x] Switch to the parent and mirror the chosen local cleanup only after remote
  success.
- [x] Implement explicit Condense with a preview, final message prompt, exact
  leases, and recovery refs.
- [x] Keep Init, Get, and Commit and Save visually primary; add no default
  keybinding for Condense.

Tests:

- [x] A single user finishes branch A into main and receives a parent-advanced
  advisory while later working on branch B.
- [x] Parent advisories do not block Get, Save, or continued editing.
- [x] Finish refuses and offers Update when the parent advanced independently.
- [x] Finish supports both retained and deleted branch choices.
- [x] Condense preserves the branch tree while replacing only branch-exclusive
  checkpoint history.

Exit gate:

- [x] The ordinary synchronization workflow still requires only Init, Get, and
  Commit and Save.
- [x] Lifecycle operations never require the user to type branch-moving Git
  commands.

## Phase 8: Add divergence and guided conflict handling

- [x] Offer Reconcile only for current-branch local/remote divergence.
- [x] Merge the fetched remote tip into the clean locally checkpointed branch.
- [x] Use the same pending-operation model for Reconcile and Update conflicts.
- [x] Record conflicting paths and surface Continue and Abort contextually.
- [x] Block unrelated WipStream mutations while an operation is pending.
- [x] Continue only after Git reports no unresolved conflicts, then commit and
  run Commit and Save.
- [x] Abort with `git merge --abort` and verify the complete recorded
  pre-merge state.
- [x] If abort verification fails, retain the receipt and report exact recovery
  state rather than claiming success.

Tests:

- [x] Clean Reconcile publishes a merge containing both clones' work.
- [x] Conflicted Update and Reconcile expose only the relevant recovery actions.
- [x] Continue refuses unresolved conflicts.
- [x] Abort restores branch, index, worktree, and operation state exactly.
- [x] Restarting VS Code rediscovers and explains a pending operation.

Exit gate:

- [x] No merge conflict can become an unnamed or unexplained repository state.

## Phase 9: Add safe Undo

- [x] Determine whether the latest completed operation is undoable from its
  receipt and current state.
- [x] Require a clean single worktree.
- [x] Verify exact local and remote after-values before changing anything.
- [x] Revert remote changes atomically with exact leases.
- [x] Revert local refs through expected-old-value transactions.
- [x] Restore the original checkout.
- [x] For Commit and Save, return checkpoint contents to the working directory
  when restoring the previous branch tip.
- [x] Refuse without mutation when later local or remote work exists.
- [x] Make Undo visible only when the current receipt is eligible.

Tests:

- [x] Undo covers Get, Init, Save, Finish-retain, Finish-delete, Condense, and
  clean Update.
- [x] Any later local commit, working-tree edit, ref move, or remote push blocks
  Undo.
- [x] Interrupted Undo remains inspectable and retryable.

Exit gate:

- [x] Users can reverse the last eligible WipStream action without reflog or
  ref-manipulation commands.

## Phase 10: Implement version 1 migration

- [ ] Read custom version 1 remote, main, feature, WIP, and last-known-WIP
  settings.
- [ ] Validate complete, synchronized `main -> feature -> WIP` topology.
- [ ] Preview advancing feature to the WIP tip and deleting only the WIP
  companion name.
- [ ] Atomically update remote feature and delete remote WIP with exact leases.
- [ ] Transactionally update local feature and delete local WIP.
- [ ] Preserve every checkpoint commit and record main as feature's parent.
- [ ] Handle an already-completed version 1 stream by initializing version 2
  normally.
- [ ] Refuse partial, divergent, rewritten-without-proof, or otherwise
  unrecognized old state.
- [ ] Write version 2 configuration only after migration and reconciliation
  complete.
- [ ] Keep legacy command handlers for one compatibility release.

Tests:

- [ ] Active default and custom-named streams migrate.
- [ ] Completed streams migrate.
- [ ] Stale second clones migrate or refuse deterministically.
- [ ] Partial and divergent streams change nothing.
- [ ] Migration is previewable, retry-safe, and undoable.

Exit gate:

- [ ] Every recognized version 1 state has a deterministic migration or
  non-mutating refusal.

## Phase 11: UI, documentation, and release verification

- [ ] Rename the primary command titles while retaining their ids and keybindings.
- [ ] Add Start and Finish as secondary Command Palette actions.
- [ ] Surface Update, Reconcile, Continue, Abort, and Undo only in their relevant
  contexts.
- [ ] Mark Condense advanced and leave it without a default keybinding.
- [ ] Make Output records include operation id, branch names, result, and safe
  next action.
- [ ] Update README diagrams, command documentation, recovery guidance, agent
  guidance, and the one-worktree warning.
- [ ] Update the live-test fixture for multiple ordinary branches and two
  separate clones.
- [ ] Run compile, automated integration tests, packaging validation, and the
  isolated two-window live test.
- [ ] Review the final diff for accidental worktree support, hidden rebase,
  background behavior, or non-atomic remote publication.

Exit gate:

- [ ] The normal documented workflow contains only Init, Get, and Commit and
  Save.
- [ ] All automated and live acceptance tests pass.
- [ ] The packaged VSIX exposes only the intended primary, secondary, and
  contextual UI.
