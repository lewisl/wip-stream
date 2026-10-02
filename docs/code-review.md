

# Code Review

## Likely bugs, most serious first

1. **Commit and Save can fail permanently after a successful Initialize (confirmed).** The "commit this machine's work" setup path reads the remote's default branch from the network. It never creates `refs/remotes/<remote>/HEAD`, but Commit and Save, Get and Finish all require that ref (`repository-model.ts:190`). A clone made with `git init` + `git remote add` has no such ref, and fetching with WipStream's explicit refspec doesn't create one; the experiment showed it stays missing. Initialize succeeds, then every later command fails with `REMOTE_HEAD_MISSING`. Only the "use the remote's version" path sets it (`remote-adoption.ts:123`).

2. **Undo can silently change restored files (confirmed).** `restoreCommitChanges` (`git.ts:673`) gets the patch through `run()`, which trims its output. If the last line of the patch adds text with trailing spaces, they're lost: the experiment returned `"+b"` for an added `"b   "`. The step also runs outside a recorded boundary (`undo-workflow.ts:201`). If `git apply` fails, refs are already reverted and the uncommitted work stays only in a recovery ref.

3. **Update from Parent can merge into the wrong branch.** `updateFromParent` runs Get from Remote first (`lifecycle-workflow.ts:201`). If the current branch was deleted remotely, Get switches to its parent. Update then merges the grandparent into that parent without the user having chosen that branch.

4. **The `Ctrl+W` shortcuts hijack existing keys.** `ctrl+w i/g/s` (`package.json:104`) makes `Ctrl+W` the start of a two-key shortcut. That probably breaks Close Editor on Windows/Linux and Switch Window on macOS.

5. **Undo and Condense stay hidden until another command runs.** The extension only activates on a command (`package.json:26`), so their `when` flags start false. Neither appears in the Command Palette until some other WipStream command has been run in that window.

6. **Initialize is very slow on large projects and fails easily.** `snapshotProject` reads and hashes every file, including ignored folders like `node_modules`, about eight times per Initialize. Any file changing during a scan (a `.DS_Store`, a build watcher) aborts it. A socket or FIFO anywhere fails it. `remote-adoption.ts:48-49` also compares every file entry against every tracked path, which gets very slow with many files.

7. **Plausible: false "state changed" refusals during Initialize.** The approval check includes a hash of `.git/index` (`setup-workflow.ts:83`). Plain `git status`, run by WipStream and in the background by VS Code's Git extension, can rewrite the index without any real change.

8. **A misleading block in Commit and Save and Initialize.** Suppose a branch was deleted locally by hand and also deleted on the remote. `initializeUnsafeBranches` (`generalized-workflow.ts:199`) has no local-tip guard, so it reports "changed locally" and stops. The next run succeeds. Get from Remote's version of the check does have the guard.

9. **Blocking leftovers.**
   - A command can fail after its receipt is written but before anything changes (for example `REMOTE_TRACKING_CHANGED`). The receipt then blocks every command until you run Recover.
   - A crash leaves `.git/wipstream/command.lock` behind. No command removes it, and the message tells you to delete it by hand.

10. **Smaller issues.**
    - Get doesn't record the tracking config it adds, so undoing Get leaves orphaned config.
    - Finish with delete leaves other `branch.<name>.*` keys behind.
    - Reconcile and Update handle a failed merge slightly differently (`conflict-workflow.ts:186` vs `lifecycle-workflow.ts:256`).
    - Recover's output shows the first status line with its leading space trimmed, so an unstaged change looks staged.

## Unclear code

- **Two Initialize implementations.** The UI uses `executeRepositorySetup`. A separate `initializeRepository` in `generalized-workflow.ts:505` is only called by tests. The two read the default branch from different sources, and it duplicates `initializationConfigurationChanges` inline. So the tests partly cover a path users never run.
- **`run()` trims by default.** That trimming caused bug 2. Four nearly identical run helpers each rebuild the same error.
- **A check with a hidden side effect.** `requireRepositoryPreflight` quietly rewrites receipts through `recoverExternalMerge`.
- **Misleading or fragile code.**
  - `requireUnchangedInitializeCheckout` is also used by Commit and Save.
  - `applyBidirectionalReconciliation` repeats the same verification block twice.
  - `remote-adoption.ts:68` uses `configuration.pop()`, which only works because of the order of another function's output.
  - Several places pick "the first incomplete operation" (`[0]`) instead of the operation they just started.
- **Unused or duplicated helpers.**
  - Five of the seven context keys in `commands.ts` are never used in `package.json`.
  - `errorCode`, `isWithin` and `fail` each exist in two or three copies.
  - Several `git.ts` helpers look unused; that's the check you stopped, so it's unverified.
- **Style that conflicts with your "obvious over clever" rule.**
  - `setup-workflow.ts` and `remote-adoption.ts` pack a lot of logic into long single lines (e.g. `setup-workflow.ts:150-152`).
  - `registerCommand` uses `runCommand.bind(undefined, …)` where a plain arrow function would be clearer.

I can expand on any item or sketch fixes, without changing code until you approve.