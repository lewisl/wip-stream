# WipStream session notes

## Current state

- The five WipStream commands are implemented: Initialize Stream, Get Current from Remote, Save to Remote, To Feature, and To Main.
- Save to Remote stages all committable changes, including untracked files, and prompts for an optional custom checkpoint message only when it will create a commit. To Feature uses that same save step; To Main creates no commit.
- Save to Remote rejects unresolved Git operations or conflicts and dirty submodules. A rejected Git commit hook leaves the staged changes available to fix and retry.
- The extension uses explicit commands only; it has no background auto-commit, pull, or push behavior.
- Automated workflow and version 1 characterization tests pass, including
  command/result/error compatibility, two-computer synchronization, unsafe
  branch states, untracked files, cancelled prompts, hook rejection, and dirty
  submodules.

## Current branch: `generalize`

- The approved ordinary-branch design is recorded in
  `docs/generalize-plan.md`.
- The ordered implementation checklist and acceptance gates are recorded in
  `docs/generalize-todo.md`.
- Phases 0 through 8 are complete. The recorded baseline is in
  `docs/v1-baseline.md`, and its executable contract is in
  `test/v1-contract.json`.
- `src/repository-model.ts` now provides read-only version 1/version 2
  configuration inspection, parent intent, symbolic remote-default resolution,
  and complete ordinary-branch inventory with remote-change classification.
- `src/repository-safety.ts` provides the repository-local command lock, and
  every mutating workflow plus every Git mutation boundary now enforces exactly
  one worktree. WipStream only lists worktrees; it never creates or manages
  them.
- `src/operations.ts` provides immutable operation plans, expected-old atomic
  local ref transactions, ordinal recovery refs, durable phase receipts,
  incomplete-operation inspection, bounded completed-receipt retention, and
  side-effect-free preview rendering.
- `src/generalized-workflow.ts` now provides transactional generalized Get from
  Remote: explicit all-head fetch, complete preflight, one atomic ordinary-ref
  update, safe checkout fallback, parity verification, recovery refs, and
  non-blocking parent advisories.
- Generalized Initialize Repository now reconciles all ordinary branches in
  both directions, refuses divergence before ordinary-ref mutation, publishes
  local advances in one exact-leased atomic push, applies remote advances in
  one local transaction, checks out the remote default, and writes version 2
  configuration last. A journaled post-push fetch and stable-state checks make
  partial remote success explicit and retryable.
- Generalized Commit and Save saves repository documents through its command
  hook, stages and checkpoints the current branch before network access, then
  uses the same repository-wide reconciliation engine as Initialize. It
  publishes all safe local advances atomically, applies unrelated remote
  advances transactionally, emits parent advisories, records checkpoint
  recovery metadata, and labels every incomplete handoff “do not resume.”
- `src/lifecycle-workflow.ts` implements optional Start, Update, Finish, and
  Condense operations. Parent intent is explicit before ancestry mutation;
  Update fetches then merges; Finish saves first and atomically publishes its
  parent update plus optional deletion; Condense is previewed, exact-leased,
  tree-preserving, and protected by recovery refs.
- `src/conflict-workflow.ts` provides contextual Reconcile plus durable pending
  merge discovery shared with Update. Continue requires resolved paths before
  committing and saving; Abort verifies the recorded branch, HEAD, index tree,
  worktree status, and Git-operation state before marking a receipt aborted.
- TypeScript now explicitly targets ES2020 with Node module resolution and
  Node/VS Code ambient types, matching the declared VS Code runtime and
  resolving editor diagnostics for modern array/string methods and Node
  built-in modules.
- The isolated two-window end-to-end live test remains a manual release check.
- Begin Phase 9 by implementing exact-state, receipt-driven Undo.
