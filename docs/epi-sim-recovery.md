# epi_sim diagnosis and recovery

Inspected repository: `/Users/lewislevin/code/epi_sim`.
Inspection and historical reproduction did not change its files, refs, or receipts.
The instructions below are for WipStream 0.2.6.

## Confirmed state at inspection

- Receipt `d554ad04-7d2f-4328-b22e-19185e13395a` records **Reconcile with Remote**
  on `feature`, stopped at `before-merge`.
- Git has no active operation. It completed merge
  `11466261d55379183f1f1c3e4a5b2050e8bda8be` with parents
  `19099f2bce29a85127bc0152b12a219efeca5e52` and
  `af0c93770efe623a33cb0839ea0cb6eefd3d5be2`.
- `feature` and the locally recorded `origin/feature` point to that merge.
  No network fetch was performed for this diagnosis.
- Subsequent uncommitted changes remain in `src/series.cpp`, `src/series.h`,
  `src/traits.h`, `test/test_series.cpp`, and `test/test_traits.cpp`.

Version 0.2.5 blocks Save on the stale receipt, while Continue and Abort require
a Git operation that has already ended. This is the confirmed recovery bug.
The 0.2.6 read-only classifier recognizes this actual receipt and history as
`merge-completed-externally`. The receipt itself was left unchanged.

## What the earlier conflict investigation established

The reflog records a commit amended from `af0c937` to `09739a2`, followed by
`19099f2`. The original and amended commits differ in documentation and build
configuration; the later commit also changes source files.

Reproducing `git merge-tree --write-tree --name-only 19099f2 af0c937` in a
disposable ordinary clone reports conflicts in the same seven files recorded
by WipStream: `SESSION.md`, `src/series.cpp`, `src/series.h`, `src/sim.cpp`,
`src/traits.h`, `test/test_plot.cpp`, and `test/test_series.cpp`.
Several conflict regions differ only in whitespace, while others differ in
content. This reproduces Git-level conflicts, rather than a conflict decision
based only on unequal hashes. It does not reconstruct the VS Code merge
editor's interaction state or establish how duplicate lines were introduced.

## Steps in the affected repository

1. Install `dist/lewisl.wipstream-0.2.6.vsix` with **Extensions: Install from
   VSIX...**, then reload VS Code. The package is built in the `wip-stream`
   repository; it has not been installed automatically.
2. Open `epi_sim` and keep `feature` checked out. Review the five corrected
   files as usual. There is no need to repeat or abort the completed merge.
3. Run **WipStream: Commit and Save**. With the inspected state unchanged,
   WipStream closes the stale receipt, commits the current corrections, and
   attempts the normal remote handoff. It does not re-merge or reset those files.
4. Wait for success. A new remote change or network problem can still prevent
   publication; follow the specific message before changing computers.

If history or checkout changed after inspection and the outcome cannot be
recognized, run **Recover Incomplete Operation**, select the named attempt,
review the displayed state, and choose **Keep Current State** if appropriate.
Then retry Commit and Save. Recovery alone does not publish any work.

These steps are instructions, not actions already taken. Applying recovery or
publishing from `epi_sim` still requires the user's separate approval.

## On the other computer

Install the same extension version. After the first computer reports a
successful Commit and Save, run **Get from Remote** in the other clone before
editing. It retrieves all ordinary branches. Select `feature` or the intended
work branch using the normal Git client.

The stale receipt is local to the affected clone; it is not copied to the other
computer by a push. A separate incomplete receipt in another clone must be
inspected on that clone. Do not copy or delete Git metadata to transfer recovery.

When the task is complete, use **Finish Branch** and verify the named parent in
its confirmation. Finishing is separate from handing work between computers.
