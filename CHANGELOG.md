# Changelog

## 0.2.0

- Generalized WipStream from a fixed main/feature/WIP stream to every ordinary
  Git branch while keeping Initialize, Get, and Commit and Save as the normal
  three-command workflow.
- Added transactional multi-branch synchronization, exact remote leases,
  operation receipts, recovery refs, parent-aware lifecycle commands, guided
  merge conflict recovery, and exact-state Undo.
- Added previewed, undoable version 1 migration that preserves every checkpoint
  commit and refuses partial, divergent, or unproven legacy state.
- Enforced exactly one Git worktree while continuing to support separate clones
  on multiple computers.

## 0.1.8

- Added keyboard shortcuts for every WipStream command: use the `Ctrl+W` chord followed by `I`, `G`, `S`, `F`, or `M`.

## 0.1.7

- Save to Remote and To Feature now support intentionally condensed local WIP history. WipStream asks before replacing the remote WIP checkpoints and refuses that replacement if another machine has changed the stream since the last successful handoff.
- Removed the personal Makadoo remote-acceptance test. The published repository now uses only self-contained disposable fixtures.

## 0.1.6

- Initialize Stream now safely gets current from the remote and starts the first editing session automatically.
- Its complete Output record explains that later editing sessions must begin with Get Current from Remote.

## 0.1.5

- Renamed the Command Palette titles to **Save to Remote** and **Get Current from Remote**; command IDs remain unchanged.

## 0.1.4

- Resume now synchronizes a clone after another machine completes its feature, leaving the clone on current `main` and removing completed temporary branches.
- Improved the isolated two-computer live test to verify that final synchronization.

## 0.1.0

- Initial local-VSIX release of WipStream.
- Added explicit `init`, `resume`, `saveup`, `tofeature`, and `tomain` commands.
