# Existing-project setup implementation checklist

Source: [messy-startup-plan.md](messy-startup-plan.md). Work stays on the
currently selected ordinary branch. Request approval before each substantial
implementation batch; do not install or publish the extension.

Development tests may use disposable temporary worktrees (approved during
implementation). Day-to-day WipStream commands still require one ordinary
clone and refuse additional worktrees.

## 1. Inspection and shared checkpoint behavior (approved)

- [x] Add setup inspection with the selected remote, all ordinary branches,
  current checkout, working-file state, configuration, and editor state.
- [x] Inspect actual state even when a copied initialization marker exists.
- [x] Keep inspection free of publication, ordinary branch changes, document
  saving, and file replacement; preserve existing repository guards.
- [x] Extract checkpoint creation for both Commit and Save and onboarding,
  honoring commit hooks without nested locks or a temporary initialized marker.
- [x] Verify inspection and checkpoint behavior in disposable ordinary clones.

## 2. Local authority and external reconciliation (approved)

- [x] Define explicit setup choices and results for completion, cancellation,
  stale preview, reconciliation, and incomplete publication.
- [x] Revalidate approved files, refs, configuration, remote state, and editor
  state under the command lock. Save documents only after proceeding and
  refresh the preview when saving changes the inspected state.
- [x] Commit this machine's changes and reuse atomic bidirectional all-branch
  synchronization, finishing on the remote default branch.
- [x] Preserve checkpoints on divergence or publication failure; clearly
  distinguish local saving from successful remote saving.
- [x] Describe affected branches and external reconciliation, recognizing
  completed external merges on the next Initialize attempt.
- [x] Verify dirty first-machine setup, existing commits, local-only branches,
  cancellation, hooks, failed publication, and external-merge retry.
- [x] Add regression tests for each major new behavior, including state changes
  that leave Git's status text unchanged and cancellation after partial progress.

## 3. Complete project backup (approved)

- [x] Create a timestamped new folder under a selected parent outside the
  source tree; never merge into or overwrite an existing destination.
- [x] Copy the entire self-contained project including Git history, ignored
  and untracked files, permissions, and symbolic links without following them.
- [x] Exclude only this attempt's transient WipStream command lock.
- [x] Verify copied contents and link targets; detect concurrent source changes.
- [x] Stop on cancellation, write failure, insufficient space, verification
  failure, or external Git storage; identify incomplete backups.
- [x] Verify backup fidelity and failure paths.

## 3a. Realistic usage-test bootstrap (approved)

- [x] Add a reusable bootstrap script for a local bare remote and independent
  ordinary clones in a sandbox temporary directory.
- [x] Seed dirty first-machine work, additional-machine work, ignored files,
  untracked files, and divergent history for actual setup exercises.
- [x] Preserve the fixture and print its paths and usage instructions, including
  backup inspection and external reconciliation followed by Initialize retry.
- [x] Run the bootstrap after Step 3 and verify its seeded repository state.
- [x] Use the fixture to test actual setup workflows as they become available;
  keep interactive Extension Development Host verification explicit.

Run `npm run test:setup-usage -- --bootstrap`, then use the printed `--verify`
and `--exercise` commands. The Step 3 exercise covers real checkpointing,
atomic publication, second-machine initialization, divergence retention,
external merge/retry, retrieval, and an independently openable backup. The
fixture and backup are preserved; it does not install an extension or claim
that VS Code dialogs have been manually verified.

## 4. Recorded remote adoption (approved)

- [x] Record approved all-branch/file effects and backup or explicit no-backup
  choice using a compatible operation-plan extension.
- [x] Recheck remote and local state before replacement, blocking ignored-path
  collisions before any destructive mutation.
- [x] Match every ordinary local branch to exact fetched remote commits using
  recovery refs and transactional ref updates; never push or make a commit.
- [x] Replace tracked files, remove non-ignored untracked files, preserve
  ignored files, and check out the remote default branch.
- [x] Preserve tags/unrelated configuration, repair tracking, and remove
  obsolete configuration for deleted branches.
- [x] Verify branch parity, checkout, files, cleanliness, and configuration
  before completing the receipt.
- [x] Verify authority cases, identical-content divergent histories, collision
  guards, stale previews, and unchanged remote refs.

The preserved usage fixture was also exercised with `--adopt`: all ordinary
branches matched the local bare remote, no remote ref moved, and the dirty
files/history remained accessible in the verified ordinary backup folder.

## 5. Interruption recovery and Undo (approved)

- [x] Journal file-replacement boundaries and retain incomplete receipts.
- [x] Display backup locations during recovery and keep backups accessible.
- [x] Allow keeping current state and a newly inspected Initialize retry,
  including interruption while detached.
- [x] Exclude remote adoption from Undo Last Action.
- [x] Inject failures at replacement, ref transaction, checkout, and
  configuration boundaries; verify receipts and safe retry.

## 6. VS Code setup choices (approved)

- [x] Keep Initialize's command ID and keyboard shortcut.
- [x] Present the three explicit choices plus cancellation; finish an already
  matching clean project without unnecessary decisions.
- [x] Explain that synchronization covers all ordinary branches.
- [x] Offer backup, explicit confirmed discard, or cancellation for adoption.
- [x] Open the folder picker at the project's parent and show the full backup
  path; offer Open Backup Folder after completion.
- [x] Report local checkpoints, reconciliation, cancellation, stale previews,
  and incomplete operations without misleading success or Undo actions.
- [x] Exercise all dialog choices and cancellation through adapter tests.

## 7. Documentation and delivery (approved)

- [x] Update setup, command-flow, and architecture documentation.
- [x] Document independent ordinary clones and retirement of folder sync.
- [x] Run the complete `npm test` suite.
- [x] Build the VSIX with `npm run package`; do not install or publish it.
- [x] Explicitly record outstanding manual Extension Development Host checks
  and provide a fresh fixture and instructions for the folder picker and
  external-reconciliation return flow.

### Verification and remaining acceptance

Final `npm test` passed on 2026-09-30, including the added external-parent cleanup
regression, setup dialogs, backend workflows, recovery, and the legacy suites.
`git diff --check` and updated documentation-link checks also passed.

The new package is `dist/lewisl.wipstream-0.2.8.vsix`. Its manifest/lockfile
version, packaged version, new setup modules, and latest safety guard were
verified. The user restored the original `0.2.7` artifact from GitHub after the
version correction; it was checked as the old build without the new setup
modules. Implementation changes were not reverted. Command-surface and setup
UI tests were rerun after the version correction.

The realistic fixture at
`/private/var/folders/75/v7g4f6zn6szf_zg6tf_8xln40000gn/T/wipstream-setup-usage-eQSGZL`
passed seed verification, `--exercise`, and `--adopt`. Checkpoint publication,
second-machine initialization, external merge/retry, retrieval, complete backup,
and remote replacement were exercised against actual ordinary clones and a
local bare remote. Original files/history remain in its verified backup folders.

A separate fresh fixture is reserved for manual Extension Development Host
checks:
`/private/var/folders/75/v7g4f6zn6szf_zg6tf_8xln40000gn/T/wipstream-setup-usage-eliRS6`.
Its generated `USAGE_TEST.md` contains the clone paths and interactive steps.
The seed was verified without exercising onboarding. See
[setup usage testing](setup-usage-testing.md) for the F5 procedure.

Manual folder-picker, Open Backup Folder, and external-reconciliation return
verification remains outstanding. Automated dialog tests verify adapter behavior
but do not claim a human used the real dialogs. No extension has been installed
or published by this work.

The additional approved directory-cleanup guard shares file removal's canonical
parent-path check. Its regression test verifies that a substituted parent link
cannot remove files or empty directories outside the project.

### Manual remote-adoption feedback and UI correction (approved)

The user tested 0.2.8 in a separate project, not the development clone. The
backup contained the uncommitted test file, and Fork verified that the working
project matched the authoritative remote without a new commit. This confirms
the manually exercised backup/replacement data behavior, not every UI acceptance
case above.

- [x] Remove explicit modal Cancel actions so VS Code supplies exactly one.
- [x] Make completion, cancellation, and terminal warning notifications
  non-blocking; retain optional backup actions and report later opening errors.
- [x] Add regressions with notifications deliberately unresolved, checking
  that actual registered-command progress ends and later actions still work.
- [x] Keep fresh-preview review and authority decisions explicitly awaited.
- [x] Run the full suite and rebuild the unreleased 0.2.8 VSIX, preserving 0.2.7.
- [ ] Retest the corrected dialogs/progress in the user's actual VS Code window.

The full suite passed after the UI correction. The rebuilt 0.2.8 package's
version and setup UI were verified against the compiled output. The restored
0.2.7 artifact remains unchanged (SHA-256
`a87441786cb86a3453668f106be033090ff21c1ccda913dd49f23096459f9510`).
