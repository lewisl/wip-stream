# The Git task beneath WipStream

WipStream's ordinary happy path is a small Git recipe. Most of the implementation is not performing novel version-control work; it is deciding when that recipe is safe, recording what it is about to change, and proving what happened afterward.

```text
Happy-path script
  = run a sequence of Git commands

WipStream workflow
  = observe repository state
    + classify every branch
    + construct exact expected transitions
    + record intent and recovery points
    + run the Git commands
    + verify the resulting state
```

The source is therefore organized more like a safety argument than a recognizable Git script.

## Underlying Git Commands

The ordinary workflows are primarily assembled from a modest set of Git command families:

| Purpose | Git commands |
| --- | --- |
| Find the repository and its shape | `rev-parse`, `worktree list` |
| Observe branches and checkout | `for-each-ref`, `symbolic-ref`, `merge-base` |
| Observe files and conflicts | `status`, `diff`, null-delimited `ls-files`, `ls-tree`, `check-ignore` |
| Read and write repository intent | `config`, `remote get-url` |
| Validate names | `check-ref-format` |
| Retrieve remote state | `fetch --prune`, `ls-remote --symref` for the actual server default |
| Checkpoint work | `add --all`, `commit` |
| Publish branch tips | `push --atomic` with exact `--force-with-lease` values |
| Move local branch tips | `update-ref --stdin` with expected old object IDs |
| Change the working checkout | `switch` |

Git still does the heavy lifting: object storage, ancestry, commits, fetch negotiation, remote publication, local ref transactions, index management, and checkout. WipStream supplies policy and coordination around those mechanisms.

The process runner keeps those command boundaries explicit. Commands that do not need input receive ignored stdin; `update-ref --stdin` receives a pipe that is closed after its transaction is written. Ordinary exit failures, signal termination, and user cancellation remain distinct. Network calls consume the cancellable progress signal; a local ref, checkout, configuration, or commit mutation is never interrupted midway. Setup also checks cancellation between steps and while copying files. No fixed network timeout is imposed.

## The three ordinary task shapes

### Initialize Repository

Validate the repository, worktree, checkout, and remote; dirty ordinary files
are allowed for inspection. Fetch every remote branch, read the server default,
classify all histories, and fingerprint files, index, configuration, and editor
state. Copied initialization markers never bypass this inspection.

Then choose authority for **all ordinary branches**:

- **Local work:** save documents after approval; refresh the preview if that
  changes state. Stage and checkpoint changes with commit hooks. If histories
  diverge, retain the checkpoint and publish nothing. Otherwise use exact leased
  atomic publication and transactional local updates, then verify parity.
- **Remote:** make and verify a complete ordinary project copy, or explicitly
  confirm discard. Reject ignored-path collisions. Record replacement, remove
  approved non-ignored untracked files, switch detached with discarded tracked
  changes to the exact remote commit, transact all local branch refs, and finish
  on the default. Never push, merge, or make a content commit. Preserve ignored
  files, tags, unrelated configuration, and accessible backup/history.
- **External reconciliation:** keep current work, name affected branches, and
  explain how to incorporate remote history in the user's Git tool. Rerun
  Initialize and choose local work; matching file contents alone is not enough.

Cancellation is available throughout. Both mutation paths verify branch parity,
checkout, files, and configuration before completing; both finish on the remote
default branch. Remote replacement is distinct from ordinary Undo because refs
cannot restore discarded uncommitted files.


### Get from Remote

Validate a clean, initialized repository.

- snapshot remote-tracking refs
- **fetch and prune every remote branch**
- classify every local/remote relationship
- refuse unpublished or divergent local work
- create, fast-forward, or delete safe local refs transactionally
- preserve the checkout, or select a surviving parent/default
- configure tracking for newly created local branches
- verify complete local/remote branch parity


### Commit and Save

Save VS Code documents.

- **stage all ordinary changes**
- **commit a checkpoint when staged content exists**
- snapshot remote-tracking refs
- fetch and prune every remote branch
- classify every local/remote relationship
- publish safe local-only or local-ahead tips atomically with exact leases
- refetch and verify publication
- apply unrelated safe remote advances locally in one ref transaction
- preserve or safely replace the checkout
- verify complete local/remote branch parity
- report whether the remote handoff is complete


## Why the wrapper is larger than the recipe

Each short Git step needs an answer to failure and concurrency questions that a happy-path shell script normally leaves implicit:

| Safety question | WipStream machinery |
| --- | --- |
| Is this a complete ordinary repository with exactly one worktree? | Repository preflight and the single-worktree assertion |
| Is another command or unfinished operation already present? | Repository command lock and incomplete-receipt inspection |
| What does each missing or unequal branch mean? | Pre-fetch snapshots and complete branch-inventory classification |
| Did local state move after it was classified? | Checkout, files/index/configuration/editor fingerprints, and expected-old ref checks |
| Did the remote move after fetch? | Exact push leases, atomic publication, refetch, and tip comparison |
| Can several local refs change without a partial result? | One `git update-ref --stdin` transaction |
| Can displaced commits still be recovered? | Recovery refs created before branch tips move or disappear |
| Can remote replacement recover uncommitted files? | Complete verified project copy before replacement; no misleading ref-only Undo |
| What if execution stops between remote and local changes? | Schema-2 operation plans, receipts, and mutation-boundary phases; cancellation after receipt creation leaves the receipt incomplete |
| Did the command achieve its goal rather than merely run successfully? | Final branch-parity and repository-state verification |

The difficult part is not issuing Git commands. It is preserving enough evidence to refuse stale assumptions, recover from partial execution, and distinguish a completed handoff from a merely successful individual subprocess.

## How to read the implementation

Read from the Git task inward rather than starting at the generic process runner:

1. [`src/registered-commands.ts`](../src/registered-commands.ts): find the `init`, `resume`, or `saveup` handler; follow `commands.ts` helpers and `setup-ui.ts` choices for the inputs and reported result.
2. [`src/setup-workflow.ts`](../src/setup-workflow.ts) for Initialize, or [`src/generalized-workflow.ts`](../src/generalized-workflow.ts) for Get/Save: follow the goal sequence and refusal points. Remote authority delegates to `project-backup.ts` and `remote-adoption.ts`.
3. In the same file, read `buildReconciliationPlan()`, its verification helpers, `executeReconciliationPlan()`, and the short `applyBidirectionalReconciliation()` orchestrator for the shared publish-then-local-update path.
4. [`src/repository-model.ts`](../src/repository-model.ts): inspect branch classification only when the workflow asks what a relation means.
5. [`src/operations.ts`](../src/operations.ts): inspect plans, receipts, recovery refs, and mutation boundaries only when the workflow crosses a recorded boundary.
6. [`src/git.ts`](../src/git.ts): translate each `GitRepository` method into its underlying Git invocation.
7. Read `execute()` last. It turns one `git` subprocess into the raw result consumed by the Git facade while preserving stdin, exit, signal, and cancellation behavior.

This reading order keeps the underlying Git goal visible while revealing each wrapper only when its safety responsibility becomes relevant. For the complete call and return sequence of each command, see [`ordinary-command-control-flow.md`](ordinary-command-control-flow.md).
