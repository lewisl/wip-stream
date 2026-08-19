# WipStream session notes

## Current state

- The five WipStream commands are implemented: Initialize Stream, Get Current from Remote, Save to Remote, To Feature, and To Main.
- Save to Remote stages all committable changes, including untracked files, and prompts for an optional custom checkpoint message only when it will create a commit. To Feature uses that same save step; To Main creates no commit.
- Save to Remote rejects unresolved Git operations or conflicts and dirty submodules. A rejected Git commit hook leaves the staged changes available to fix and retry.
- The extension uses explicit commands only; it has no background auto-commit, pull, or push behavior.
- Automated workflow tests pass, including two-computer synchronization, untracked files, cancelled prompts, hook rejection, and dirty submodules.

## Current branch: `generalize`

- The generalized multi-stream design and implementation sequence are recorded
  in `docs/generalize-plan.md`.
- The current implementation is the version 1 compatibility baseline. Its
  isolated two-window end-to-end live test is still outstanding.
- Begin implementation with the first slice described at the end of the plan;
  keep existing commands and tests passing while separating repository settings
  from stream-scoped state.
