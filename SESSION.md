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
- Phases 0 and 1 are complete. The recorded baseline is in
  `docs/v1-baseline.md`, and its executable contract is in
  `test/v1-contract.json`.
- `src/repository-model.ts` now provides read-only version 1/version 2
  configuration inspection, parent intent, symbolic remote-default resolution,
  and complete ordinary-branch inventory with remote-change classification.
- The isolated two-window end-to-end live test remains a manual release check.
- Begin Phase 2 by enforcing the one-worktree invariant and a repository-local
  WipStream command lock before any mutating workflow is generalized.
