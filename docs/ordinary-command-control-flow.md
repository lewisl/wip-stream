# Ordinary command control flow

This document traces the three ordinary WipStream commands from VS Code command dispatch through repository mutation and back to the user interface. It focuses on call order, mutation boundaries, and the value returned at each layer.

For the shorter, Git-first view of these workflows, see [`git-task-structure.md`](git-task-structure.md).

The commands are:

| Command | Command ID | Workflow entry point |
| --- | --- | --- |
| Initialize Repository | `wipstream.init` | `initializeRepository()` |
| Get from Remote | `wipstream.resume` | `getFromRemote()` |
| Commit and Save | `wipstream.saveup` | `commitAndSave()` |

The relevant implementation is in [`src/extension.ts`](../src/extension.ts), [`src/commands.ts`](../src/commands.ts), and [`src/generalized-workflow.ts`](../src/generalized-workflow.ts). Repository classification is in [`src/repository-model.ts`](../src/repository-model.ts), mutation journaling is in [`src/operations.ts`](../src/operations.ts), locking is in [`src/repository-safety.ts`](../src/repository-safety.ts), and Git calls are in [`src/git.ts`](../src/git.ts).

## Common dispatch and return path

Extension activation has one entry point:

```text
activate(context): void
  -> registerCommands(context): void
       -> register wipstream.init, wipstream.resume, and wipstream.saveup
```

Each registered handler returns `runCommand(...)`, a `Promise<void>`. `runCommand` appends a `START` line, runs the handler inside a non-cancellable VS Code progress notification, catches errors for `showError()`, and always calls `refreshCommandContexts()` in `finally`.

The common adapter path is:

```text
VS Code command handler(): Promise<void>
  -> runCommand(output, title, action): Promise<void>
       -> action(): Promise<void>
            -> selectRepository(): Promise<GitRepository>
            -> command-specific adapter and workflow calls
       <- action resolves with void, or throws
       -> showError(error): Promise<void>                 [only when action throws]
       -> refreshCommandContexts(activeRepository): Promise<void>
  <- Promise<void>
```

`selectRepository()` discovers repositories from the active file and workspace folders. It returns the only `GitRepository`, prompts and returns the selected one when several exist, or throws a `CommandUiError` when none exists or selection is cancelled.

Each workflow entry point wraps its unlocked implementation in `withRepositoryCommandLock()`. The lock helper returns the unlocked implementation's result unchanged and releases the repository-local lock in `finally`, including when the workflow throws.

### Error versus result

`fail()` in the generalized workflow throws a `GeneralizedWorkflowError`; it does not return an error value. Git and UI failures also throw. These errors rise through the command action to `runCommand()`, which reports them and then refreshes command visibility.

Commit and Save has an additional non-exception path. Once it has made or retained a safe local checkpoint, several expected synchronization failures are converted to a `CommitAndSaveResult` with `published: false` and `handoff: "do-not-resume"`. `reportSave()` renders that result as a warning instead of an error. This distinction is detailed in the Commit and Save section.

## Common branch classification

The workflows snapshot remote-tracking tips before fetch, fetch and prune all ordinary remote branches, snapshot again, and call `inspectBranchInventory()`. That function returns one `BranchInventoryEntry` per name found in local refs, fetched remote refs, or the pre-fetch remote snapshot.

| `relation` | Meaning after fetch | Initialize / Commit and Save | Get from Remote |
| --- | --- | --- | --- |
| `equal` | Local and fetched remote tips match | No ref update | No ref update |
| `local-ahead` | Local history strictly contains remote history | Publish local tip | Reject as unpublished local work |
| `local-only` | Local branch has no current or previously observed remote tip | Create remote branch | Reject as local-only work |
| `remote-ahead` | Remote history strictly contains local history | Fast-forward local branch | Fast-forward local branch |
| `remote-only` | Remote branch has no local branch | Create local branch | Create local branch |
| `diverged` | Neither tip contains the other | Reject automatic reconciliation | Reject automatic retrieval |
| `remotely-deleted` | A branch existed in the pre-fetch snapshot but is now absent remotely | Delete the local branch only if its tip still equals the previously observed remote tip; otherwise reject | Same safe-delete rule |

For Initialize, an unsafe classification throws. For Commit and Save, it becomes a `published: false` result after any new checkpoint has been retained. Get uses the stricter `unsafeBranches()` check, which also rejects `local-ahead` and `local-only`.

## Shared bidirectional reconciliation

Initialize Repository and Commit and Save both finish through `applyBidirectionalReconciliation()`. It returns an `AppliedReconciliationResult`, which is also the complete shape of `InitializeRepositoryResult`:

```ts
{
  operationId: string;
  checkout: string;
  published: readonly string[];
  created: readonly string[];
  fastForwarded: readonly string[];
  deleted: readonly string[];
}
```

The sequence is:

1. Convert the inventory into exact local ref updates and exact-leased remote ref updates. Calculate the branch-name arrays returned as `published`, `created`, `fastForwarded`, and `deleted`.
2. `createOperationPlan()` returns an immutable `OperationPlan` containing the command, expected and proposed refs, leases, checkout transition, configuration changes, optional checkpoint, and destructive effects.
3. `beginOperation()` writes and returns a planned `OperationReceipt`. From this point onward, a stopped operation can be discovered by `inspectIncompleteOperations()`.
4. Verify that remote-tracking refs, the checkout, local branch tips, and the worktree still match the state that was classified. A mismatch throws and leaves the receipt incomplete for inspection.
5. For Commit and Save with a new checkpoint, create a recovery ref for the pre-checkpoint tip inside a journaled `local-refs` mutation boundary.
6. If local branches must be published, call `pushRefsAtomic()` inside a `remote-push` boundary. It issues one atomic push with one exact `--force-with-lease` per ref and returns `void`. Fetch again inside a `remote-fetch` boundary, verify the expected remote tips, and recheck local state.
7. If the checked-out local ref will move, detach `HEAD` inside a `checkout` boundary. `applyLocalRefTransaction()` then creates recovery refs for displaced tips and applies every local create, update, and delete in one expected-old `git update-ref --stdin` transaction; it returns `void`.
8. Switch to the target branch when the checked-out ref moved or the requested target differs from the original checkout.
9. `verifyBranchParity()` returns `void` only when every ordinary local and selected-remote branch has relation `equal`; otherwise it throws.
10. Apply planned Git configuration changes inside a `configuration` boundary. Configuration is deliberately deferred until ref parity has been proved.
11. `completeOperation()` records the final refs, checkout, and status, marks and returns the completed receipt, and prunes old completed receipts. The reconciliation helper discards that receipt and returns the `AppliedReconciliationResult` shown above.

`withMutationBoundary()` records `before-<boundary>`, calls the supplied action, records `after-<boundary>`, and returns the action's value unchanged. If the action throws, the receipt remains at its last recorded phase.

## Initialize Repository (`wipstream.init`)

### Adapter sequence

```text
init handler(): Promise<void>
  -> selectRepository(): Promise<GitRepository>
  -> saveRepositoryDocuments(repo): Promise<void>
  -> readRepositoryConfiguration(repo): Promise<
       { kind: "uninitialized" } |
       { kind: "initialized"; remote: string }
     >
  -> askValue("Git remote", "origin"): Promise<string>  [uninitialized only]
  -> initializeRepository(repo, requestedRemote):
       Promise<InitializeRepositoryResult>
  -> showSuccess(...): void
  <- void
```

Saving documents happens before workflow preflight. It moves dirty file-backed editor buffers into the working tree; Initialize then refuses that dirty working tree rather than silently committing it.

An uninitialized repository gets a trimmed remote string from the user. For an already initialized repository the adapter passes `undefined`, and the workflow uses the configured WipStream remote.

### Workflow sequence

`initializeRepository()` acquires the `Initialize Repository` command lock and returns `initializeRepositoryUnlocked()`'s result.

1. `requireStableInitializeRepository()` returns `void` after proving exactly one worktree, a non-bare and non-shallow repository, no active Git operation, no conflicts, a clean worktree, and no incomplete WipStream operation. Any failed check throws.
2. `readRepositoryConfiguration()` returns the configured-state union. The requested remote is validated against it, `ensureRemote()` proves that the remote exists, and `currentBranch()` must return a branch name rather than `null`.
3. `snapshotRemoteTips()` returns the pre-fetch `ReadonlyMap<branch, objectId>`. The workflow performs an initial inventory inspection, calls `fetchAllBranches()` (`git fetch --prune` with the full branch refspec) and receives `void`, then obtains the remote default branch, post-fetch tip map, and classified inventory.
4. `initializeUnsafeBranches()` returns unsafe divergent or ambiguous-deletion entries. A non-empty array causes a throw after remote-tracking refs have been refreshed but before any ordinary local branch, remote branch, checkout, or WipStream configuration change.
5. The fetched default-branch tip must exist. `verifyAtomicPushSupport()` performs an exact-leased atomic dry-run no-op update and returns `void` or throws.
6. Build configuration transitions for the full fetch refspec, tracking configuration for every synchronized branch, and `wipstream.remote`. The latter is the initialized marker and is not written yet.
7. Call the shared `applyBidirectionalReconciliation()` with the remote default branch as `targetCheckout`.
8. Return its value as `InitializeRepositoryResult`.

The adapter logs the checkout and all four branch lists, then reports success. The required `operationId` identifies the completed receipt.

## Get from Remote (`wipstream.resume`)

### Adapter sequence

```text
resume handler(): Promise<void>
  -> selectRepository(): Promise<GitRepository>
  -> assertNoDirtyDocuments(repo): void
  -> getFromRemote(repo): Promise<GetFromRemoteResult>
  -> appendAdvisories(output, result.advisories): void
  -> showSuccess(...): void
  <- void
```

The adapter does not save documents. `assertNoDirtyDocuments()` throws when a file-backed document inside the repository has unsaved editor content, preventing retrieval from replacing files that VS Code has not written.

### Workflow sequence

`getFromRemote()` acquires the `Get from Remote` command lock and returns `getFromRemoteUnlocked()`'s result.

1. `requireStableGetRepository()` returns `void` after the same structural checks as Initialize: one worktree, non-bare, non-shallow, no active Git operation, no conflicts, a clean worktree, and no incomplete WipStream operation.
2. `readRepositoryConfiguration()` must return `{ kind: "initialized", remote }`. The workflow proves the remote exists and requires `currentBranch()` to return a branch name.
3. Snapshot pre-fetch remote tips, inspect once, fetch and prune all branches, resolve the remote default, snapshot fetched tips, and return the classified inventory.
4. `unsafeBranches()` rejects divergence, local-only branches, unpublished local advances, and ambiguous remote deletion. A rejection may leave updated remote-tracking refs, but it occurs before a plan or ordinary local mutation.
5. `localUpdates()` returns exact expected-old updates for remote-only creation, remote-ahead fast-forward, and proved remote deletion. `checkoutAfterGet()` returns the current branch unless it will be deleted; in that case it returns a surviving recorded parent, then the remote default as fallback, or throws if neither survives.
6. `createOperationPlan()` returns a plan with local ref and checkout transitions but no remote updates, and `beginOperation()` returns its planned receipt. A plan is recorded even when there are no ref updates.
7. Recheck that remote-tracking refs have not moved. When refs will be updated, also recheck that the worktree is still clean.
8. If the checked-out ref will change, detach. Apply all local changes plus recovery refs in one transaction. For newly created local branches, record their selected-remote tracking configuration. Switch to the selected surviving checkout when detachment occurred.
9. Verify complete branch parity. Inspect the now-equal inventory and `parentAdvisories()` returns an advisory per non-default branch with state `current`, `probably-integrated`, `parent-advanced`, or `parent-missing`.
10. Complete the receipt and return:

```ts
{
  operationId: string;
  updated: boolean; // true when at least one local ref update was applied
  checkout: string;
  created: readonly string[];
  fastForwarded: readonly string[];
  deleted: readonly string[];
  advisories: readonly ParentAdvisory[];
}
```

The adapter writes non-current advisories to the Output panel. It uses `updated` to choose between an "already current" notification and a "branches retrieved" notification.

## Commit and Save (`wipstream.saveup`)

### Adapter sequence

```text
saveup handler(): Promise<void>
  -> selectRepository(): Promise<GitRepository>
  -> saveHooks(repo): CommitAndSaveHooks
       saveDocuments(): Promise<void>
       requestCheckpointMessage(default): Promise<string>
  -> commitAndSave(repo, hooks): Promise<CommitAndSaveResult>
  -> reportSave(output, result): Promise<void>
  <- void
```

The document-saving and checkpoint-message calls happen inside the locked workflow through the supplied hooks. `reportSave()` logs parent advisories first. A result with `published: true` produces the success notification. A result with `published: false` produces a warning and, when `reconcileBranch` is present, offers to invoke `wipstream.reconcile`.

### Checkpoint sequence

`commitAndSave()` acquires the `Commit and Save` command lock and returns `commitAndSaveUnlocked()`'s result.

1. Call `hooks.saveDocuments()` and receive `void` after all dirty file-backed repository documents have been saved.
2. `requireStableSaveRepository()` proves one worktree, non-bare, non-shallow, no active Git operation, no conflicts, no dirty submodules, and no incomplete WipStream operation. It intentionally permits ordinary working-tree changes because they are the content to save.
3. Require initialized configuration, an existing selected remote, and a current ordinary branch.
4. Read the current branch tip, call `stageAll()` (`git add --all`) and receive `void`, then call `hasStagedChanges()` and receive a boolean.
5. If content is staged, request and validate a message, call `commit()` and receive `void`, then record the before tip, after tip, branch, and message as a `CheckpointTransition`. Git commit hooks run normally. If no content is staged, no message is requested and `checkpointCreated` is `false`.
6. Require an empty porcelain status. If files changed during checkpoint creation, throw while retaining the local checkpoint.

### Synchronization sequence

1. Snapshot pre-fetch remote tips and inspect the inventory. Fetch all branches.
2. A Git fetch failure classified as offline or remote-unavailable returns an unsuccessful result immediately; the local checkpoint remains. Other error types still throw.
3. Resolve the remote default, snapshot fetched tips, and classify the inventory. Divergence or an ambiguous remote deletion returns an unsuccessful `unsafe-branches` result. If the checked-out branch diverged, that result also returns `reconcileBranch` so the UI can offer Reconcile with Remote.
4. Calculate the target checkout and tracking-configuration transitions, then call the shared `applyBidirectionalReconciliation()` with the optional checkpoint.
5. If reconciliation succeeds, inspect parent advisories and return a successful `CommitAndSaveResult`.
6. If reconciliation throws after its receipt was created, inspect the incomplete receipt created by this command and convert the error to an unsuccessful result. Preflight ensures that no older incomplete receipt exists:
   - a network error becomes `failure: "offline"`;
   - an exact-lease rejection at `before-remote-push` becomes `failure: "remote-changed"`;
   - another push rejection at that phase becomes `failure: "remote-unavailable"`;
   - a stop at any other recorded phase becomes `failure: "incomplete"`.

If no incomplete receipt exists, the error is rethrown instead of being guessed into a result.

### Returned result

```ts
{
  operationId?: string;
  checkpointCreated: boolean;
  published: boolean;
  handoff: "complete" | "do-not-resume";
  message: string;
  checkout: string;
  publishedBranches: readonly string[];
  created: readonly string[];
  fastForwarded: readonly string[];
  deleted: readonly string[];
  advisories: readonly ParentAdvisory[];
  failure?:
    | "offline"
    | "unsafe-branches"
    | "remote-changed"
    | "remote-unavailable"
    | "incomplete";
  unsafeBranches?: readonly UnsafeBranch[];
  reconcileBranch?: string;
}
```

On success, `published` is `true`, `handoff` is `"complete"`, and `publishedBranches` is the shared reconciliation engine's `published` list. `published: true` means the handoff is complete even when that list is empty because every branch was already equal or only local updates were needed.

On a handled synchronization failure, `published` is `false`, `handoff` is `"do-not-resume"`, the returned `checkout` field names the original branch, the branch-effect and advisory arrays are empty, and the message includes the instruction not to resume from another clone. For `failure: "incomplete"`, callers must inspect the receipt rather than infer the repository's current checkout or ref state from that field; the empty branch-effect arrays also do not prove that no boundary completed. `operationId` is present only when reconciliation created a receipt; fetch and unsafe-classification failures occur before that point.

## Mutation and observation summary

| Stage | Initialize | Get | Commit and Save |
| --- | --- | --- | --- |
| Save VS Code documents | Yes, before workflow | No; refuses unsaved documents | Yes, through a locked hook |
| Permit dirty ordinary files | No | No | Yes, then stages and checkpoints them |
| Fetch before ordinary ref mutation | Yes | Yes | Yes |
| Publish local-ahead/local-only branches | Yes | No | Yes |
| Apply remote-ahead/remote-only branches locally | Yes | Yes | Yes |
| Target checkout | Remote default | Preserve current unless safely deleted | Preserve current unless safely deleted |
| Operation plan written | Before shared reconciliation mutations | Before local mutations, even for no-op parity | Before shared reconciliation mutations, after optional checkpoint |
| Parent advisories returned | No | Yes | Yes on success |
| Successful return contract | `InitializeRepositoryResult` | `GetFromRemoteResult` | `CommitAndSaveResult` with complete handoff |
| Expected safe refusal contract | Throw | Throw | Often `CommitAndSaveResult` with do-not-resume handoff |
