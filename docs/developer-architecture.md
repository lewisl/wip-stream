# WipStream developer architecture

WipStream is a goals-oriented layer over Git. The extension presents a small set of repository workflows while retaining ordinary Git branches, commits, and remotes underneath. It does not maintain a parallel version-control database.

For the small Git recipe underlying the ordinary workflows and the safety machinery wrapped around it, see [`git-task-structure.md`](git-task-structure.md). For a call-by-call map of Initialize Repository, Get from Remote, and Commit and Save, including their return values and mutation boundaries, see [`ordinary-command-control-flow.md`](ordinary-command-control-flow.md).

The repository model supports every ordinary branch in a repository. A user normally works on one checked-out branch, can consult other branches, and uses the remote to hand committed work between clones. WipStream deliberately requires one worktree per clone. Separate clones on separate computers are supported; multiple Git worktrees in one clone are not.

## System shape

The main dependency direction is:

```text
VS Code
  |
  v
extension.ts -> commands.ts
                    |
                    v
              workflow modules
                    |
                    +--> repository-model.ts
                    +--> operations.ts
                    +--> repository-safety.ts
                              |
                              v
                            git.ts -> Git executable
```

Only the extension and command-adapter layers depend on the VS Code API. The workflow and Git layers are ordinary TypeScript modules, so their behavior can be tested directly with local repositories and without launching VS Code.

## Source organization

### VS Code adapter

- [`src/extension.ts`](../src/extension.ts) is the extension entry point. It activates WipStream and delegates command registration.
- [`src/commands.ts`](../src/commands.ts) is the user-interface adapter. It registers command IDs, selects the repository, saves editor buffers, gathers confirmations and branch names, formats results for the Output panel, bridges cancellable progress to network Git subprocesses, and maintains VS Code context keys that control when optional commands appear. Business rules belong in workflow modules rather than here.
- [`src/errors.ts`](../src/errors.ts) supplies the shared `WipStreamError` and `fail()` foundation. Specialized errors remain only where callers need extra structured data, such as Git process details, an unsafe-branch inventory, or command-lock metadata.
- [`src/constants.ts`](../src/constants.ts) contains shared Git configuration keys.

### Workflow modules

- [`src/generalized-workflow.ts`](../src/generalized-workflow.ts) implements the three normal workflows: **Initialize Repository**, **Get from Remote**, and **Commit and Save**. It inventories all ordinary branches, classifies their local and remote relationships, rejects unsafe combinations before changing ordinary state, performs synchronized updates, verifies the result, and reports parent-branch advisories.
- [`src/lifecycle-workflow.ts`](../src/lifecycle-workflow.ts) implements optional branch-lifecycle operations: **Start Branch**, **Update from Parent**, **Finish Branch**, and **Condense Branch**. A branch's parent is recorded as intent, not inferred repeatedly from history. Updating from a parent uses a merge; history is not silently rebased or rewritten.
- [`src/conflict-workflow.ts`](../src/conflict-workflow.ts) handles cases that need a human decision: **Reconcile with Remote**, **Continue Pending Merge**, and **Abort Pending Merge**. It records enough pre-merge state to verify that an abort restores the intended state.
- [`src/undo-workflow.ts`](../src/undo-workflow.ts) implements exact-state **Undo Last Action**. Undo is available only for the newest eligible completed operation and only while the repository still matches that operation's recorded after-state. Remote reversal uses leases, so work that appeared later is not overwritten.

Some workflow modules intentionally compose others. For example, lifecycle actions use the normal Get and Save workflows, and conflict reconciliation can finish through Commit and Save. They still remain independent of the VS Code API.

### Repository and transaction infrastructure

- [`src/git.ts`](../src/git.ts) is the low-level Git command facade. It runs the Git executable and provides typed operations for refs, branch relationships, status, commits, checkouts, merges, fetching, exact leased pushes, and multi-ref transactions. Subprocess stdin is ignored unless a caller supplies input, and failures retain their exit code or termination signal. A repository-scoped cancellation signal applies only to fetch and push; local mutations are allowed to finish. The facade enforces the single-worktree rule immediately before every mutation. This module may inspect `git worktree list`, but WipStream never creates or manages worktrees.
- [`src/repository-model.ts`](../src/repository-model.ts) translates raw refs and Git configuration into the model used by workflows. It distinguishes initialized clones by their selected WipStream remote, inventories branch tips before and after fetch, classifies branch relationships and remote changes, resolves the remote's default branch, and reads or records parent intent.
- [`src/repository-safety.ts`](../src/repository-safety.ts) serializes WipStream commands within a clone and provides the shared repository preflight. The preflight checks repository shape, Git-operation state, conflicts, command-specific cleanliness, and incomplete WipStream operations in one fixed order. The repository-local command lock detects another running command and leaves stale locks visible for deliberate inspection after interruption.
- [`src/operations.ts`](../src/operations.ts) provides operation plans, receipts, mutation-boundary journaling, recovery refs, local ref transactions, previews, and incomplete-operation inspection. Each planned remote transition contains its ref, exact expected value, and proposed value together. New plans use schema 2; legacy schema-1 plans are validated and normalized in memory when read, without rewriting their receipts. This gives recovery and Undo code a concrete record of what was expected and what actually completed.

## Repository state

WipStream uses several kinds of state, each for a different purpose:

| State | Location | Purpose |
| --- | --- | --- |
| Ordinary work | `refs/heads/*` and the working tree | Normal Git branches, commits, staged files, and uncommitted files |
| Remote observations | `refs/remotes/<remote>/*` | Last fetched view used to classify what changed remotely |
| Repository configuration | local Git config under `wipstream.*` | Selected remote and initialized/uninitialized state |
| Parent intent | local Git config under `branch.<name>.wipstreamParent` | The branch that **Update from Parent** and **Finish Branch** should use |
| Command lock | the common Git directory at `wipstream/command.lock` | Prevents concurrent WipStream mutations in one clone |
| Operation receipts | the common Git directory at `wipstream/operations/*.json` | Records plans, boundaries, outcomes, and pending recovery work |
| Recovery refs | `refs/wipstream/recovery/<operation>/<ordinal>` | Keeps pre-operation commits reachable when refs move or are deleted |

The lock and receipt paths are under the repository's Git directory, not the checked-out project directory. They are private operational metadata and are never committed or pushed. Internal `refs/wipstream/*` refs are also excluded from the ordinary branch inventory.

The remote is the durable handoff point between computers. **Commit and Save** completes a handoff only after all intended remote branch updates succeed and their final tips are verified. A browser or hosting site does not determine which local branch another clone should check out; each clone retains its own current branch when that remains possible.

## How a compound operation works

The details vary by command, but mutation-heavy workflows follow the same shape:

1. Acquire the repository command lock and run the shared repository preflight, including command-specific worktree and submodule cleanliness policy.
2. Check workflow-specific state, such as initialization, checkout, branch relationships, pending-merge recovery, or Undo eligibility.
3. Snapshot remote-tracking tips, fetch all ordinary remote branches, and classify the complete branch inventory.
4. Refuse before changing ordinary branches, the checkout, or WipStream configuration if the relationships cannot be handled safely. Fetching may already have updated remote-tracking refs; those refs are observations, not user branches.
5. Construct an immutable operation plan with expected-old local transitions, unified `{ ref, expected, proposed }` remote transitions, checkout and configuration transitions, checkpoint information, and destructive effects.
6. Write an operation receipt before crossing a mutation boundary.
7. Push remote changes atomically with exact leases when the command publishes or deletes remote refs. Refetch and verify the result.
8. Apply related local ref changes with one `git update-ref --stdin` transaction using expected old object IDs. Recovery refs preserve displaced commit tips.
9. Apply checkout and Git-configuration transitions only after the remote and local ref boundaries are safe. Their exact order is command-specific; writing the selected WipStream remote, which marks the clone initialized, is deferred until branch reconciliation has succeeded.
10. Verify postconditions such as local/remote parity, record the after-state, and complete the receipt.

Expected-old checks and remote leases turn an unnoticed concurrent change into a refusal instead of an overwrite. Receipts remain incomplete when an operation stops inside a recoverable boundary, allowing the extension to offer only the recovery action appropriate to the recorded state.

Commands that may fetch or push expose VS Code cancellation. Cancellation stops only the active network subprocess: before a receipt exists it is an ordinary cancellation, while after journaling starts the incomplete receipt remains authoritative and must be inspected. WipStream does not impose an arbitrary network timeout.

Merge conflicts are a special case because Git must leave the index and working tree available for human editing. WipStream records a pending merge, exposes Continue and Abort, and does not pretend the compound operation is complete until one of those paths is verified.

## Workflow families

The command set is intentionally larger than the normal path because exceptional goals need explicit names:

- Normal use: **Initialize Repository**, **Get from Remote**, and **Commit and Save**.
- Optional branch lifecycle: **Start Branch**, **Update from Parent**, and **Finish Branch**.
- Explicit history cleanup: **Condense Branch**.
- Conflict recovery: **Reconcile with Remote**, **Continue Pending Merge**, and **Abort Pending Merge**.
- Exact reversal: **Undo Last Action**.

The command palette uses context keys maintained by [`src/commands.ts`](../src/commands.ts) to hide operations that do not apply to the current repository state. The workflow layer still validates every precondition; UI visibility is guidance, not a safety boundary.

## Libraries and tools

WipStream intentionally uses a small runtime stack:

- The [VS Code Extension API](https://code.visualstudio.com/api) supplies command registration, prompts, editor saving, workspace selection, context keys, and the Output panel. It is imported only by `extension.ts` and `commands.ts`.
- Node.js built-ins provide process execution and private metadata handling: `child_process`, `fs` / `fs/promises`, `path`, `os`, and `crypto`.
- The installed Git command-line program is the version-control engine. WipStream uses Git's native atomic ref transactions and push leases rather than a JavaScript Git implementation.
- TypeScript is compiled in strict mode for Node 16 modules with an ES2020 target. `@types/node` and `@types/vscode` supply platform types.
- `vsce` builds the installable VSIX package.

There is currently no third-party npm runtime dependency.

## Tests

Tests are plain Node.js scripts. They use Node's assertion, filesystem, process, path, and temporary-directory APIs to create disposable repositories, bare remotes, and multiple clones. This exercises the real Git executable without requiring network access or a running VS Code instance.

The suites mirror the source structure:

- [`test/git.test.js`](../test/git.test.js), [`test/repository-model.test.js`](../test/repository-model.test.js), [`test/repository-safety.test.js`](../test/repository-safety.test.js), and [`test/operations.test.js`](../test/operations.test.js) cover Git process behavior and the common model and safety machinery.
- [`test/get-from-remote.test.js`](../test/get-from-remote.test.js), [`test/initialize-repository.test.js`](../test/initialize-repository.test.js), and [`test/commit-and-save.test.js`](../test/commit-and-save.test.js) cover normal use across branch inventories and clones.
- [`test/lifecycle-workflow.test.js`](../test/lifecycle-workflow.test.js), [`test/conflict-workflow.test.js`](../test/conflict-workflow.test.js), and [`test/undo-workflow.test.js`](../test/undo-workflow.test.js) cover the optional and recovery paths.
- [`test/command-surface.test.js`](../test/command-surface.test.js) checks the extension manifest, command IDs, titles, keybindings, context visibility, and registered handlers.
- [`test/live.js`](../test/live.js) drives the packaged extension through an isolated two-window manual test environment.

Use `npm test` for compilation and the automated suite, `npm run package` to compile and produce a VSIX, and `npm run test:live` for the packaged live-test setup.

## Adding or changing a workflow

The established separation is useful when extending WipStream:

1. Put prompts, VS Code notifications, buffer saving, and context-key updates in `commands.ts`.
2. Put the goal and its repository rules in a workflow module that does not import `vscode`.
3. Add reusable Git observations or primitives to `git.ts`; keep policy out of that layer.
4. Extend `repository-model.ts` when a workflow needs a new shared classification of repository state.
5. Acquire the command lock and perform all safe preflight checks before ordinary mutations.
6. Represent compound mutations as an operation plan. Use exact old values for local ref transactions and one unified expected/proposed transition per remote ref.
7. Record each mutation boundary, preserve recoverable tips, and defer configuration changes until the refs they describe are safely established.
8. Verify the requested goal as a postcondition rather than treating a successful individual Git command as sufficient.
9. Add tests for the successful path, safe refusal, interruption or retry where applicable, concurrent remote movement, and any resulting Undo or contextual-command behavior.

New behavior should preserve the core constraints: no background synchronization, no managed multi-worktree state, no silent rebase, no unproved deletion, and no force-like update without an exact expected prior value.
