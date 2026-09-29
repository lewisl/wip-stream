# WipStream-compatible Git commands

For occasional work outside VS Code, in an existing Git clone. Assume the usual
Git settings, one remote named `origin`, one developer, and one editing computer
at a time. Use these commands for the branches you actually work on.

**Before editing**

Start with a clean working tree. Replace `my-task` with an existing remote branch
that you want to work on, or use as the starting point for a new branch:

```sh
git fetch origin
git switch my-task
git merge origin/my-task
```

Fetch refreshes your local record of the remote branches. Switch selects the
local branch, creating it with tracking if it exists only on `origin`. Merge
brings the fetched changes into that branch: it fast-forwards when possible
and otherwise attempts a merge. If Git reports conflicts, resolve them, then
run `git add -A` and `git commit` to finish the merge before starting new work.

**To create a new work branch, optionally**

After updating the starting branch above:

```sh
git switch -c my-new-task
```

This creates and selects a local branch. The push below publishes it.

**Checkpoint whenever useful, and always before leaving**

Save your editor's files, then:

```sh
git add -A
git commit -m "Describe the changes"
git push -u origin HEAD
```

Add stages new files, edits, and deletions. Skip add and commit if everything
is already committed. `HEAD` means the current branch here; `-u` establishes
its remote tracking. This push works for both new and existing branches.

Repeat for every branch you worked on. **Every final push must succeed before
switching computers.** Intermediate checkpoints are useful; the last handoff
is essential.

Next session, repeat the start sequence, or use **WipStream: Get from Remote**
in your initialized VS Code clone before editing. The other computer needs
only Git for this workflow.
