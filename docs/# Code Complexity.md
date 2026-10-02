# Code Complexity

No, most of it isn't required. Some of it is, but much of the size comes from design choices made along the way, not from the job itself.

The code is also larger than you think: `src/` is about **6,000 lines**, not 2,000. The biggest files are `generalized-workflow.ts` (937), `git.ts` (796), `operations.ts` (767), `lifecycle-workflow.ts` (470), `registered-commands.ts` (399) and `commands.ts` (369).

## What's genuinely needed

- **Saving and getting:** stage, commit, fetch, and push or fast-forward. That's the handful of Git commands you described.
- **Refusing when unsafe:** stop when the branch has diverged, when Get would overwrite uncommitted work, or when a push is rejected. Git already refuses most of these itself; the extension mainly needs to explain the refusal clearly.
- **Reporting status:** one output channel and a success or error message.
- **VS Code wiring:** registering commands and finding the repository.

That's a few hundred lines, maybe 500–800 with clear error messages.

## Where the rest comes from

1. **A transaction journal on top of Git.** Every command writes a receipt with phases, mutation boundaries, recovery refs and recorded config changes, and Recover replays or closes them. Git's ref updates are already crash-safe, and the reflog and `ORIG_HEAD` already record what moved. This journal is the largest layer and drives most of the bugs in the review: findings 1, 2, 9 and parts of 10 are all about keeping receipts consistent.
2. **Syncing every branch on every save.** Commit and Save and Get sort all branches into equal, remote-ahead, local-only, remote-only, diverged, or deleted-on-the-remote, then push or move them together. Working on the current branch only would remove most of `generalized-workflow.ts`.
3. **Undo.** Exact reversal of remote pushes, local refs, config, checkout, restored checkpoint files and the remote HEAD. That's what requires the receipts to record everything. Without it, "undo the last save before it's pushed" is `git reset --soft HEAD~1`.
4. **A custom command lock with stale-lock recovery.** Git already locks the index and refs. The lease-ref recovery added in this round is careful work, but it's new code solving a problem created by the earlier lock.
5. **Setup's three paths.** "Use the remote's version" includes a full project backup, hashing of every file, ignored-file preservation checks and checking that the working tree didn't change mid-scan. That's `setup-workflow.ts`, `remote-adoption.ts`, `project-backup.ts` and `project-snapshot.ts`, about 800 lines for something done once per machine.
6. **The branch lifecycle commands.** Start, Update from Parent, Finish, Condense and the guided conflict workflow are features beyond save and get. They may be worth keeping, but they aren't part of the core.
7. **Checking things twice.** Many steps re-read state Git has just reported, such as matching the remote-tracking tips before and after, or checking the checkout and config after setting them.

## My view

The complexity follows from one early goal: **every command must be transactional, undoable and recoverable across all branches.** If that goal is right, most of the code is justified. For a tool that moves work-in-progress between your own machines, I don't think it is. Git's own refusals, `--force-with-lease`, the reflog and clear messages give nearly the same safety at a fraction of the size. They would also be much easier to read, which your AGENTS.md asks for.

A simpler design would:
- sync the current branch only;
- drop receipts, Undo and Recover, and point to the reflog instead;
- have Setup set the remote and refuse anything unusual instead of reconciling it;
- keep the lifecycle commands only if you actually use them.

---

well, all very interesting.  what this shows is that wrapping git is very hard because git is a complicated beast.  Fork does the absolute best job and its undo is very context fragile. what the extension does is try to great "goal defined" commands rather than atomic actions, which is what git is designed around.  git is the assembly language of version control because those operations are needed (if often quite rare). what git is lacking is a friendly "high level", expressive compiled language to reduce direct usage of the assembly language. it works for probably the largest open source project with the most maintainers.

---

Your assembly-language analogy fits well. One difference explains why WipStream had to be so defensive.

A compiler owns its machine; a Git wrapper doesn't. Compiled code runs on a machine nothing else is writing to. A Git wrapper works on shared state that other things change while it runs:
- the remote, which your other machines push to;
- VS Code's own Git extension refreshing the index in the background;
- you at the command line.

So a "goal-defined" command can't just generate a sequence of Git commands and trust it. It has to:
- check that nothing changed between planning and acting (the leases and the "state changed" refusals);
- record what it intended, in case it's interrupted halfway (the receipts);
- explain afterwards what actually happened.

That makes it closer to a database transaction layer than to a compiler, and that's where most of the 6,000 lines go.

Others have tried to build that higher-level language:
- Gitless came out of MIT research on why Git's concepts confuse people, and tried to simplify those concepts.
- Sapling, from Meta, offers a friendlier command set with undo and a "smartlog" view.
- Jujutsu (jj) is the closest to what you described. It can run on top of an ordinary Git repository, and it keeps an operation log: every command is recorded as one unit, and jj undo reverses it. That is essentially WipStream's receipt journal, built into the version-control layer. Undo is reliable there because every command records itself, instead of a wrapper reconstructing what Git did.

That also explains why Fork's undo is fragile. Like WipStream, it sits outside Git and has to infer intent from Git's low-level history after the fact.

Why Git works for the Linux kernel: its building blocks suit that workflow. Many maintainers exchange patches and merge each other's histories, and Git's commands match those steps directly. Your workflow, one person carrying work-in-progress across machines on many branches, doesn't map onto any single Git command. That gap is what WipStream fills, and why it costs so much code.

---

 Which of Gitless, Sapling or Jujutsu (sure it's not Jujitsu?) is actually reliable to use in production and is comprehensively maintained?

⏺ Web Search("jujutsu jj vcs latest release 2026")
Did 1 search in 5s

⏺ Web Search("Sapling SCM facebook release 2026")
Did 1 search in 5s

⏺ Web Search("gitless version control maintained")
Did 1 search in 5s

Jujutsu is the one to use. Sapling is solid but focused on Meta's own needs, and Gitless is no longer maintained.

The spelling is Jujutsu, and its command is jj. "Jujitsu" is the common English spelling of the martial art, but the project uses "Jujutsu".

|  | Status | Production-ready? |
|---|---|---|
| Jujutsu (jj) | Very active, with a release every month in 2026. The latest is 0.45.0 (September 2, 2026), which added `jj converge` for resolving divergent commits. | Yes, with one caveat. It's still at version 0.x, so commands and config occasionally change between releases, and you'll need to read the changelog when upgrading. Its creator works at Google, which backs it. It can share a folder with an existing Git clone, so you can try it on a real repository and go back to plain Git at any time. |
| Sapling (sl) | Maintained by Meta, with regular dated builds. The August 11, 2026 release included security fixes. | Mostly. Meta uses it internally at huge scale, but the open-source version mainly works with GitHub repositories. Its priorities follow Meta's internal needs, and parts of its server side aren't supported outside Meta. |
| Gitless | Inactive: an MIT research project with no recent releases. | No. It's useful only for its ideas, such as having no staging area. |

For your workflow, one point matters: Jujutsu's operation log and jj undo are local to each machine, just like WipStream's receipts. Moving work between machines still means pushing to a Git remote.

Jujutsu handles that more simply than plain Git, because the working copy is always a commit, so there's no separate "save" step. But it doesn't automatically sync all branches across machines. You would still run jj git push --all and jj git fetch yourself, or wrap them in a small script. That would be far smaller than WipStream, because jj already provides the operation log and undo.

Sources:
- Jujutsu changelog
- Sapling release 0.2.20260811
- Gitless on GitHub
- Gitless at MIT CSAIL
- Gitless home page