# Setup usage testing

The setup sandbox uses a local bare remote and independent ordinary clones.
It does not install an extension, contact a hosted remote, alter an existing
project, or automatically delete backups. Fixtures are intentionally preserved
for inspection; use a fresh bootstrap for each first-use run.

## Bootstrap and automated exercise

Run from the WipStream development repository:

```sh
npm run test:setup-usage -- --bootstrap
```

The script prints the fixture root, its `USAGE_TEST.md`, and verification and
exercise commands. Use that root in these commands:

```sh
setup_fixture=/path/printed/by/bootstrap
npm run test:setup-usage -- --verify "$setup_fixture"
npm run test:setup-usage -- --exercise "$setup_fixture"
npm run test:setup-usage -- --adopt "$setup_fixture"
```

`--verify` checks the original seed state. `--exercise` checkpoints first-machine
work, publishes all safe branches, initializes an additional machine, retains
a divergent checkpoint without publishing, completes an external Git merge,
retries setup, retrieves the result on the other clones, and verifies a complete
project backup. `--adopt` then exercises real backup-backed remote adoption,
checking unchanged remote tips, complete local branch parity, and retained
original files/history. Both commands mutate only the disposable fixture.

Do not run `--exercise` on the fixture reserved for interactive first-use tests:
it intentionally advances the repositories. An already-exercised fixture is
not expected to pass the original seed-state check again.

## Extension Development Host checks

1. Bootstrap a fresh fixture and keep its printed instructions open.
2. Open the WipStream source repository in VS Code. In Run and Debug, select
   **Run Extension** and press F5. The existing launch configuration compiles
   the source and starts an Extension Development Host; no VSIX installation
   is required.
3. In that host, use **File → Open Folder** to open the selected fixture clone.
   Run **WipStream: Initialize Repository**. Keep WipStream Output visible for
   branch relations, operation IDs, checkout, and full backup paths.

| Clone / case | What to verify |
| --- | --- |
| `first-machine` | Choose this machine's work. Check staged/unstaged changes, additions, deletion, existing commits, local-only publication, ignored files, and final default checkout. |
| `additional-machine` | Initialize retrieves all published ordinary branches and checks out the remote default. |
| `copied-machine` | Its existing WipStream marker does not bypass dirty-file or history inspection. |
| `adoption-machine` | Choose remote authority and copy. Confirm the folder picker starts at the project's parent; choose the fixture's `backups` folder. Check the displayed full path and explicitly select Open Backup Folder. Verify dirty files, staged state, ignored files, tags, and local-only commits in the ordinary backup; verify unchanged remote refs. |
| `divergent-machine` | Local-work setup retains a checkpoint and publishes nothing. Complete `git merge origin/main` in the clone's Git tool, then rerun Initialize and choose local work. The existing merge is published, not recreated. |
| Dialog cancellation | On fresh fixtures, dismiss the authority, backup, folder-picker, and discard-confirmation dialogs. Modal confirmations should show one Cancel. No saving, replacement, publication, or success message should follow; command progress should end without dismissing the informational notice. |
| Completion notification | Leave the success notice open. Command progress should already be finished. Open Backup Folder must still work if selected afterward, and no folder should open when it is not selected. |
| Stale approval | Edit a file or unsaved buffer during a preview/message prompt. Expect a fresh preview and a new choice, not reuse of old discard approval. |

Explicit discard needs a separate fresh fixture; inspect its confirmation before
proceeding. Folder-picker display, notification interaction, and the real Git
tool-to-Initialize return are manual checks, even when their adapters have tests.
Opening a backup does not automatically restore it or authorize publishing it.

## Verification record

Automated workflow and dialog verification is recorded in
[messy-startup-todo.md](messy-startup-todo.md). The dialog suite uses a mocked
VS Code API; the usage exercise uses actual Git repositories and a local remote.
Neither is evidence that a human has exercised the real folder picker.

Manual Extension Development Host verification remains outstanding for the
folder picker, Open Backup Folder interaction, and external-reconciliation
return flow. The fresh fixture's generated `USAGE_TEST.md` is the handoff for
those checks. Do not report this manual acceptance item as complete until it
has been performed.

`npm run package` builds a VSIX only. The older `npm run test:live` helper installs
the VSIX into its isolated test profile; it is not used by this no-install setup
verification workflow.
