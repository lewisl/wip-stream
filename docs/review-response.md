# Code review response and implementation plan

The implementation order should follow shared dependencies while fixing the highest-risk behavior early. Each stage should be a separate, reviewable change with its own regression checks.

This plan covers all findings in [code-review.md](code-review.md). Code implementation requires approval under [AGENTS.md](../AGENTS.md).

1. **Preserve Git output exactly where it represents data.**  
   Addresses **2, 10**, and the trimming-helper concern.

   Use raw output for patches and porcelain status. Keep trimming explicit for scalar results such as branch names and commit IDs. Audit other callers before changing the general `run()` contract, so fixing whitespace does not break existing parsers.

   Verify trailing spaces, tabs, missing final newlines, binary patches, and the first porcelain status line. Undo must restore identical file contents, and Recover must distinguish staged from unstaged changes.

2. **Add the receipt information needed by the upcoming fixes.**  
   Establishes prerequisites for **1, 2, 9, 10**.

   Record checkpoint restoration inputs in the Undo plan and put restoration inside a mutation boundary. Define how changes to the remote symbolic HEAD are recorded and handled by Undo. Retain the operation ID when creating a receipt, replacing error paths that select the first incomplete operation.

   Keep existing receipts readable. Add only the specific metadata and transitions these fixes require; avoid a general workflow redesign.

   Verify receipt round trips, compatibility with existing receipts, correct operation selection, and interruption immediately before and after each new boundary.

3. **Complete Undo’s content and configuration guarantees.**  
   Addresses the rest of **2** and the Get configuration issue in **10**. Depends on **1–2**.

   Record Get’s tracking configuration changes with their previous values. Make Undo reverse those recorded changes. Before reporting successful Undo, verify restored checkpoint contents and the expected configuration.

   A failed or interrupted restoration must leave an identifiable incomplete operation and preserve the checkpoint through recovery refs. Recover should describe the remaining work accurately; it must not silently replay restoration over later edits.

   Verify Get → Undo, existing configuration with multiple values, restoration failure after refs move, and interruption after files are restored but before completion is recorded.

4. **Make both Initialize paths establish the same usable repository state.**  
   Addresses **1, 8**, the duplicated Initialize behavior, and fragile configuration ordering. Depends on **2**.

   Share the small pieces that determine the remote default branch, construct initialization configuration, and establish final repository state. Preserve the legacy clean-only API’s calling contract. Do not route callers through UI prompts.

   Set and verify the remote symbolic HEAD through the recorded workflow. Add the missing local-tip guard to the shared unsafe-branch check. Construct the initialization marker explicitly instead of relying on `configuration.pop()`.

   Verify a repository created through `git init` and `git remote add`, both setup choices, the legacy API, and subsequent Get, Commit and Save, and Finish commands. Test a branch deleted both locally and remotely on the first attempt.

5. **Protect branch identity and align lifecycle behavior.**  
   Addresses **3** and the Finish/configuration and merge-failure issues in **10**.

   Capture Update’s intended branch before Get. After Get, acquire the Update lock and verify that the checkout still matches. If Get replaced a deleted checkout, report that outcome and stop before merging.

   Make Reconcile and Update follow the same explicit policy for failed merges, including an active merge with no conflict paths. Retain pending state when Git actually has an active merge; otherwise report the failure with its receipt intact.

   When Finish deletes a branch, record and remove all configuration keys belonging to that exact branch.

   Verify a deleted feature branch whose parent also has a parent, a checkout change between commands, ordinary conflicts, zero-conflict merge failures, and similarly prefixed branch names. Verify Finish → Undo restores all deleted configuration.

6. **Make interrupted operations recoverable without manual lock deletion.**  
   Addresses **9** and preflight’s hidden recovery side effect. Depends on **2–5**.

   Separate recognition of externally completed merges from read-only preflight validation, while retaining that useful behavior.

   Close a refused operation automatically only when the workflow can prove that it made no changes. Account for checkpoints created before the receipt. Once a mutation boundary has been entered, retain recovery requirements unless the result is established conclusively.

   Add a supported stale-lock recovery path that checks ownership and process liveness and prevents concurrent reclamation. Live, foreign-host, or unreadable locks require explicit handling rather than an assumption that they are safe to remove.

   Verify refusals before mutation, ambiguous publication failures, dead-owner locks, live-owner locks, malformed records, and competing recovery attempts.

7. **Separate setup approval checks from full preservation scans.**  
   Addresses **6–7**. Depends on **4 and 6**.

   First reproduce the suspected index-refresh refusal. Replace raw index-file hashing with a semantic comparison that captures staged content and relevant index flags.

   For local-work setup, inspect tracked and non-ignored work that the operation can actually commit or change. For backup and remote replacement, retain the broader preservation checks for ignored content.

   Reduce repeated hashing without weakening checks at mutation boundaries. Precompute tracked directory ancestors instead of repeatedly searching all tracked paths. Detect unsupported special entries early in preservation paths and give an actionable explanation.

   Verify harmless index refreshes, real staging changes, changing tracked files, ignored-directory activity, ignored-path collisions, and special filesystem entries. Measure scan counts and bytes read on a large fixture; avoid timing-dependent tests.

8. **Fix command discovery and shortcut behavior.**  
   Addresses **4–5** and unused context calculations.

   Remove the global `Ctrl+W` chords; leave commands available for user-assigned shortcuts. Preserve conditional visibility for Undo and Condense, but activate and populate their contexts when a fresh window opens.

   Remove context calculations with no consumer, retaining backend eligibility checks as the authority.

   Update manifest tests and verify a fresh VS Code window before any WipStream command runs. Check command visibility, eligibility refresh, and normal keyboard behavior on supported platforms.

9. **Finish with focused clarity cleanup.**  
   Addresses the remaining “Unclear code” findings. Follows the behavior fixes.

   Rename the shared checkout check and make its errors command-specific. Preserve verification before and after configuration changes, using an obvious shared function if that improves readability.

   Expand dense expressions, replace `.bind()` with a direct callback, and consolidate genuinely identical helpers. Remove unused Git helpers only after checking compatibility obligations. Keep specialized error helpers where their behavior differs.

   This stage should change no workflow behavior.

The main dependency chain is **output preservation → receipt support → Undo correctness → initialization consistency**. Lifecycle fixes can then build on those guarantees, followed by recovery and setup-performance work. UI work is largely independent; cleanup comes last so it does not obscure correctness changes.

Before implementation, run the existing suite to establish a baseline. For each stage, run its focused regression checks and the required compilation checks. Finish with the full suite and representative command sequences through the public setup path, including failure and recovery.

## Implementation and verification — October 1, 2026

All nine stages are implemented. Application changes are in the TypeScript sources; the JavaScript files under `test/` are authored tests, separate from generated files under `out/`.

The existing suite established the baseline, and focused checks were run during implementation. After the approved pauses and corrections, final verification passed:

- `npm test`: TypeScript compilation and all 20 test scripts, including seven review regression groups. Coverage includes exact patch bytes and configuration values, receipt ownership, Undo restoration interruptions, both public setup choices, subsequent Get/Save/Finish, checkout races, merge failures, stale-lock recovery, semantic index changes, and command contexts.
- Remote-adoption interruption checks cover failures before and after the remote HEAD mutation. Undo checks cover failures before file restoration, after restoring files, and after recording the restoration boundary.
- The setup scan fixture reads two Git-visible files and their actual byte counts while skipping 300 ignored files of 32 KiB each. Ignored watcher activity and a socket do not invalidate local-work setup; full preservation still refuses unsupported special entries.
- The isolated VS Code startup test passed on macOS: automatic activation and all 12 command registrations were verified before invoking a WipStream command, followed by a real Get adapter call. Run it with `npm run test:startup` when the `code` CLI is available.
- `git diff --check` passed. The working clone remains on `main`, with no incomplete WipStream operation, command lock, or lock-recovery lease. Changes remain uncommitted.

Shortcut protection is verified by manifest assertions requiring no default keybindings. Native keyboard interaction on Windows and Linux was not exercised.
