# Test verification

`npm test` compiles TypeScript and runs 25 ordinary Node scripts sequentially.
The workflow fixtures use real Git, a local bare remote, and ordinary temporary
clones. Tests do not create Git worktrees or need a network service.

Fixtures assert relevant prerequisites before invoking a command: a missing
remote HEAD, existing branch, actual divergence, pending merge, checkpoint
contents, or a concurrent remote advance. Refusal cases compare user-visible
state before and after. Exact content is checked against original byte buffers;
remote results are checked directly in the bare remote or another clone.

## Additional review coverage

- `public-command-sequences.test.js`: both public setup choices without
  `origin/HEAD`, uninterrupted everyday command sequences, and Undo of a
  public local-work setup checkpoint.
- `lifecycle-recovery.test.js`: Finish retain/delete and Condense interruptions
  around publication, fetch, local transactions, checkout, configuration, and
  final verification. Recover must preserve later staged, unstaged, and
  untracked work. A competing clone verifies Finish's atomic remote lease.
- `workflow-refusals.test.js`: Start and Condense refusals, Reconcile refusal
  conditions, and protection of another clone's old history after Condense.
- `command-handlers.test.js`: registered callbacks, workflow arguments,
  confirmations, pending results, operation selection, cancellation signals,
  progress policy, and error reporting. This replaces source-format checks.
- `receipt-reader.test.js`: valid receipts and malformed/unreadable inputs
  supplied through an isolated filesystem reader stub. Persisted receipts are
  never hand-edited. Planned and outcome local-ref updates are validated for
  entry structure, full ref names, full SHA-1/SHA-256 object IDs, duplicate refs,
  and invalid null combinations. Valid legacy receipts remain readable.

The existing conflict, Undo, context, initialization, and operation tests also
cover active Reconcile continuation, changed-checkout refusal, aborted-merge
Undo eligibility, absent-before tracking configuration, deleted/binary
checkpoint files, multiple repository selection, cleared repository context,
supported Recover before retry, and preservation of required recovery refs
during completed-receipt pruning.

Run an individual script with `node test/<name>.test.js` after compilation.
The lifecycle interruption suite includes 38 cases; it takes longer than the
small adapter tests because every case uses real Git.

One-time detection checks also deliberately reintroduced raw-output trimming,
omitted public setup's remote HEAD transition, and enabled whitespace fixing
during checkpoint restoration. Each change was made in a disposable project
copy and compiled successfully. The relevant test failed at an assertion for
the examined behavior, then passed with the unchanged implementation restored.
No mutation-testing dependency or permanent mutation harness was added.

## Platform and host checks

`npm run test:portable` excludes scripts requiring POSIX executable hooks,
symlinks, executable file modes, Unix sockets, or the executable fake Git.
`npm test` selects this same subset on Windows and prints every exclusion;
that result is a portable-subset result, not full platform validation.
The remaining review regression groups still run in the portable subset.
Module mocks compare resolved paths rather than POSIX path suffixes.

`npm run test:startup` separately opens an isolated VS Code test host. It
requires the `code` CLI and a graphical session. It verifies automatic
activation and command registration before invoking a real Get adapter.
Mocked context tests verify the startup eligibility flags. Neither test claims
to exercise native keyboard interaction or visually inspect the command palette.

## Outstanding policy questions

The formerly opt-in malformed-local-ref reproducer now passes and is included
in the default receipt-reader suite, along with independent negative fixtures
for each invalid field and positive fixtures for creation, replacement,
deletion, and unchanged refs.

Retention of aborted, undone, and recovered receipts, and eventual removal of
unneeded recovery refs, need an approved policy before adding automatic cleanup
expectations. Existing pruning tests require preservation of snapshots for
retained receipts and incomplete operations. They do not prescribe permanent
retention of every obsolete snapshot.
