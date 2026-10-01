# Make existing-project setup straightforward

## Goal

Support the first machine adopting WipStream and additional machines joining an existing project. Users must be able to choose the authoritative work without first cleaning up Git manually.

Keep **Initialize Repository** as the entry point. Inspect actual repository state even when local configuration says WipStream is already initialized; copied projects can carry that configuration from another machine.

## Three explicit setup choices

### 1. Use the remote’s version

The remote is authoritative. Offer:

- **Copy project, then use remote.**
- **Use remote without a backup**, with explicit confirmation of the local state being discarded.
- **Cancel.**

For the backup option, open a VS Code folder picker initially pointing to the project’s parent directory. Create a new timestamped backup folder under the chosen location and display its full path.

Copy the entire project, including `.git`, ignored files, and untracked files. This preserves both working files and local commit history in an ordinary folder the user can open.

After successful backup—or explicit choice to proceed without one:

- Match **all ordinary local branches** to the selected remote.
- Create missing branches and remove local-only branches.
- Replace tracked files and remove non-ignored untracked files.
- Preserve ignored files; stop before replacement if a remote path would overwrite one.
- Check out the remote default branch and finish configuration.
- Do not push, merge, or create a content commit.

Different histories with identical file contents are handled by this same path.

Provide **Open Backup Folder** afterward. The user can copy selected changes back, run **Commit and Save**, and then **Get from Remote** on another machine.

### 2. Commit this machine’s work and save to remote

This machine contains work the user wants to retain and publish. This is a primary setup choice, equivalent in purpose to running **Commit and Save** during onboarding.

- Save file-backed editor documents.
- Stage non-ignored additions, modifications, and deletions.
- Ask for a commit message and create a checkpoint when there are changes, honoring commit hooks.
- Include existing local commits even when no new checkpoint is needed.
- Fetch and publish safe local advances and local-only branches using the existing atomic synchronization workflow.
- Retrieve compatible remote advances and complete initialization.

The preview must explain that synchronization covers all ordinary branches.

If history diverges, retain the checkpoint locally and publish nothing. Identify the branches requiring reconciliation and offer the third path. Do not silently force-push or replace remote history.

Cancellation or publication failure must clearly distinguish **work saved locally** from **work successfully saved to the remote**.

### 3. Resolve differences locally, then save to remote

The user chooses the desired chunks and resolves the histories in their existing Git tool.

- Identify affected branches and explain the required next step.
- Do not build a new conflict editor.
- Allow the user to return by rerunning Initialize.
- Reinspect current state and continue through **Commit this machine’s work and save to remote**.
- Recognize a completed external merge; do not require the user to recreate it.

Explain that matching file contents alone does not resolve divergent history. The completed reconciliation must incorporate remote history before normal publication can succeed.

**Cancel** remains available throughout setup. A clean repository already matching the remote can finish configuration without unnecessary decisions.

## Implementation and recovery

### Inspection and orchestration

- Separate inspection from execution. Add setup inspection data, an explicit execution choice, and results distinguishing completion, cancellation, and required reconciliation.
- Inspection may fetch remote-tracking information but must not publish, change ordinary branches, save editor buffers, or replace working files.
- Save editor documents only after the user chooses to proceed. Stop on save failure and reinspect afterward.
- Revalidate the approved state under the existing command lock. Changes to files, branches, or editor buffers require a fresh preview.
- Preserve existing guards for unsupported repository layouts, active Git operations, and incomplete WipStream operations. Point to the appropriate recovery action.
- Keep the existing command ID and keyboard shortcut. Mark a fresh repository initialized only after successful setup.
- Preserve Initialize’s existing final checkout of the remote default branch and report that branch clearly.

### Backup

- Require a new destination outside the source tree. Never overwrite or merge into an existing directory.
- Preserve permissions and symbolic links without following links outside the project.
- Copy before creating the replacement operation receipt; exclude the transient WipStream lock created by this attempt.
- Verify copied contents and link targets, and detect source changes during copying.
- Cancellation, insufficient space, copy failure, or verification failure prevents replacement. Identify any incomplete backup clearly.
- Support ordinary self-contained clones. Refuse to claim a complete backup when Git storage depends on locations outside the project.
- Never automatically restore, publish, or delete the backup.

### Workflow reuse and remote replacement

- Extract existing checkpoint behavior so the local-work path can commit before initialization without temporarily setting the initialized marker or nesting command locks.
- Reuse existing bidirectional synchronization for safe publication.
- Implement remote adoption as a distinct recorded operation using exact fetched commit IDs, existing workflow APIs, recovery references, and transactional ref updates.
- Record approved branch/file effects, backup location or explicit no-backup choice, and file-replacement mutation boundaries.
- Preserve tags and unrelated Git configuration. Update branch tracking and remove obsolete configuration for deleted branches.
- Recheck remote state before replacement; changed remote state requires a refreshed preview.
- Extend operation records compatibly, retaining support for existing receipts.

### Failure handling

- Preserve the backup and incomplete receipt after interruption.
- Recovery must display the backup location, allow keeping current state, and permit a newly inspected setup attempt.
- Exclude remote adoption from ordinary **Undo Last Action**: restoring refs cannot restore discarded uncommitted files. The ordinary backup folder is the recovery source.
- Never report success until branch parity, checkout, tracked contents, non-ignored worktree cleanliness, and configuration are verified.
- Do not manually modify Git refs or operation receipts outside the repository’s workflow APIs.

## Tests and delivery

Use disposable ordinary clones and a local bare remote.

- **Machine onboarding:** fresh clone, dirty first machine, additional machine, copied initialization marker, and non-default current branch.
- **Remote authority:** local-ahead, remote-ahead, local-only, divergent, and identical-content divergent branches. Verify all-branch parity, unchanged remote refs, and no new content or merge commit.
- **Local authority:** staged/unstaged changes, additions, deletions, existing commits, local-only branches, commit-hook failure, cancelled message, and publication failure.
- **Reconciliation:** divergence retains the local checkpoint and publishes nothing; externally completing the merge permits successful retry.
- **Backup:** complete files and history, ignored files, permissions, links, invalid destinations, failed writes, cancellation, and concurrent source changes.
- **Replacement:** ignored files survive, ignored-path collisions block before mutation, and stale previews are rejected.
- **Recovery:** inject failures around file replacement, branch transactions, checkout, and configuration. Verify accessible backups, accurate receipts, and safe retry.
- **UI:** exercise every choice and dialog cancellation; ensure partial completion never produces a success message or misleading Undo action.

Run `npm test`, build the VSIX, and manually verify the folder picker and external-reconciliation return flow in an Extension Development Host. Update setup and command-flow documentation. Do not install or publish automatically.

Document the migration away from folder synchronization: each machine needs an independent ordinary clone that the previous sync service no longer modifies. Configuring external sync services is outside this feature.

Acceptance: users can adopt the remote, publish this machine’s work, or reconcile externally and return—without deleting the clone or losing unapproved local work.

## Plan storage and implementation status

This plan is implemented in the step-by-step approved batches recorded in
[messy-startup-todo.md](messy-startup-todo.md), including the added realistic
usage-test bootstrap after Step 3. Major functionality has regression tests.

Disposable worktrees are permitted for development testing only; the extension's
day-to-day single-worktree restriction remains. Packaging never authorizes
installation or publication. Manual Extension Development Host verification
is tracked separately from automated workflow and dialog tests.
