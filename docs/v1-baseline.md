# Version 1 compatibility baseline

This baseline protects the existing WipStream behavior while the generalized
ordinary-branch model is introduced. It was recorded on 2026-08-19 from commit
`aa30aa5`, before any runtime source change on the `generalize` branch.

## Automated result

The pre-change command was:

```text
npm test
```

It compiled the extension and completed with:

```text
WipStream workflow integration tests passed.
```

The Phase 0 suite now runs that unchanged workflow test followed by
`test/v1-characterization.test.js`. Both pass without a change to `src/`.

## Executable compatibility contract

`test/v1-contract.json` is the version 1 contract inventory. Its test verifies:

- every activation event, command id, title, and default keybinding;
- every declared Initialize, Resume, Finish, and Save failure result;
- both boolean To Feature results;
- every literal `WorkflowError` code in the workflow and VS Code command layer;
- an explicit version 2 compatibility expectation for every command and error;
- the fixture responsible for each important version 1 repository state.

The three primary ids remain `wipstream.init`, `wipstream.resume`, and
`wipstream.saveup`. The legacy `wipstream.tofeature` and `wipstream.tomain` ids
remain for one compatibility release as specified by the generalization plan.

## Characterized repository states

| State or behavior | Automated coverage |
| --- | --- |
| Active and completed streams | `test/workflow.test.js` |
| Stale clone and two-clone handoff | `test/workflow.test.js` |
| WIP rewrite and stale rewrite refusal | `test/workflow.test.js` |
| Partial local and partial remote streams | `test/v1-characterization.test.js` |
| Local-ahead and divergent temporary branches | `test/v1-characterization.test.js` |
| Completed remote with unfinished local work | `test/v1-characterization.test.js` |
| Offline handoff and remote push race | `test/v1-characterization.test.js` |
| Commit-hook refusal and staged-work preservation | `test/workflow.test.js` |
| Dirty submodule refusal | `test/workflow.test.js` |
| Cancelled checkpoint message and untracked files | `test/workflow.test.js` |

The isolated two-window VS Code live test remains a manual release validation.
It is not part of the deterministic Phase 0 automated gate.
