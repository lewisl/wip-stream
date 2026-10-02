# Test Suite Review

## How the suite is built

`npm test` runs 19 plain Node scripts one after another, with no test framework and no coverage measurement. Most tests drive real `git` against a local bare "remote" and ordinary clones in temporary folders. The VS Code parts are tested by replacing the `vscode` module with mocks. `command-surface.test.js` only checks `package.json` and pattern-matches the source text.

**Well covered:** Get from Remote, Commit and Save, the setup paths (both "this machine's work" and "use the remote"), project backup, and merge recovery. The tests inject failures at specific steps, such as `beforeRemotePush`, `afterRemotePush`, or swapping out `repo.switch`, to check what happens when an operation is interrupted. `remote-adoption-recovery.test.js` interrupts remote adoption at nine different points.

## Why the earlier bugs got past the tests

| Bug from the review                             | Why no test catches it                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Missing `origin/HEAD` after setup            | Every fixture creates clones with `git clone`, which sets `origin/HEAD`. The recovery fixture runs `git remote set-head` explicitly (`recovery-workflow.test.js:40`), which hides the bug. No test runs Commit and Save after the real setup path. |
| 2. Undo drops trailing whitespace               | The Undo test file contains `"saved content\n"`, which has no trailing whitespace. No test makes `git apply` fail either.                                                                                                                          |
| 3. Update from Parent after Get switches branch | No test deletes the current branch remotely before running Update.                                                                                                                                                                                 |
| 4. `Ctrl+W` shortcuts                           | `command-surface.test.js:36-40` asserts those exact shortcuts, so the test locks the conflict in.                                                                                                                                                  |
| 5. Undo and Condense hidden until activation    | The test checks that each command has an activation event. It doesn't check that the `when` flags are set before the first command runs.                                                                                                           |
| 6. Slow and fragile project scans               | All fixtures are tiny. None has a large ignored folder or a FIFO/socket, and none has a background `git status` rewriting the index.                                                                                                               |
| 8. Remotely deleted branch with no local branch | The branch classification test (`repository-model.test.js:165`) has no such case.                                                                                                                                                                  |
| 9. Receipts and lock left behind                | Get's refusals that happen after its receipt is written are untested. The stale-lock test only checks the refusal; there is no way to clear the lock, so there's nothing to test there.                                                            |

## Structural gaps

1. **Most tests set up their repos through a path users never take.** Every repo in the Undo, lifecycle, conflict, Commit and Save, recovery and safety tests is initialized with the test-only `initializeRepository`. The real UI calls `executeRepositorySetup`, and only the setup tests use it, so no test exercises the real setup followed by everyday commands. Undo of Initialize is also only tested on the test-only path.
2. **One test closes an incomplete operation in a way users can't.** `initialize-repository.test.js:238` calls `completeOperation` directly to close the interrupted operation; a user would have to use Recover.
3. **Most VS Code command handlers are untested.** Only the `init` and `recover` handlers are driven. These are never exercised:
   - the handlers for resume, saveup, start, finish, update, reconcile, continue, abort, undo and condense;
   - their confirmation dialogs (Abort, Undo, Condense);
   - `selectRepository` choosing among several repositories;
   - `handleCommandError` after `activeRepository` has been reset.
4. **Lifecycle commands have no interruption or refusal tests.** Unlike setup, nothing injects failures into Finish or Condense. Also untested:
   - Start Branch refusals: invalid name, branch already exists locally or remotely, detached HEAD;
   - Finish when the remote parent moved before the push;
   - Condense refusals: nothing to condense, cancelled, parent not an ancestor;
   - what a second clone sees after Condense (it will report the branch as diverged).
5. **Conflict handling gaps.**
   - Continue is only tested after Update from Parent, not after Reconcile.
   - The `OTHER_DIVERGENCE` and `CURRENT_BRANCH_NOT_DIVERGED` refusals, and Continue after the checkout changed, are untested.
6. **Undo gaps.**
   - Undo after an aborted merge, where it matters which receipt counts as the latest.
   - Undo of a Get that created branches; their tracking config is left behind.
   - Checkpoints containing deleted or binary files when restoring uncommitted work.
7. **Receipt housekeeping is untested.**
   - Receipts with status aborted, undone or recovered are never pruned, and recovery refs are never cleaned up; no test covers either kind of growth.
   - One corrupt receipt file blocks every command; untested.
8. **`git.ts` is only tested against a fake `git`.** Nothing checks that output is returned unchanged; the default trimming in `run()` caused bug 2.
9. **Only macOS/POSIX is exercised.** The tests assume POSIX hooks and symlinks, so Windows and Linux differences (e.g. `lchmod`, path separators) are untested.

## Readability of the test code

- **Duplicated fixture code.** Fixture helpers (`git`, `configureIdentity`, `createFixture`, `withFixture`) are copied into about 10 files even though `setup-fixture.js` exists. The copies differ slightly; for example, only one runs `remote set-head`.
- **Dense style.** `undo-workflow.test.js` puts several statements on each line, which makes it hard to follow and doesn't match your "obvious over clever" guidance.
- **Text matching instead of behaviour.** `command-surface.test.js` pattern-matches source formatting (e.g. `registerCommand(context, output, "init", ..., true,`), so a harmless reformat breaks it. It also checks for leftover names (`confirmMigrationPreview`, `@firecrawl/anydoc-wasm`) that no longer mean anything.
- **No coverage numbers.** Adding a tool such as `c8` would show which lines and branches are untested; that's a new dev dependency, so your call.

## Tests worth adding first

1. Real setup (`executeRepositorySetup`) on a clone without `origin/HEAD`, followed by Commit and Save. This reproduces bug 1.
2. Undo of a checkpoint whose last added line ends in spaces. This reproduces bug 2.
3. Update from Parent while the current branch has been deleted remotely. This reproduces bug 3.
4. Interruption tests for Finish and Condense, matching the existing adoption pattern.
5. Undo after an aborted merge, and Undo of a Get that created branches.
6. Switch the Undo, lifecycle and conflict fixtures to the real setup path, or add one end-to-end test that does.

I can draft any of these as a proposal for you to approve before anything is written.