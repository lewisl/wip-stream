# Repository guidance for coding agents

- Work in this clone and its currently selected ordinary branch.
- Never create, attach, move, repair, prune, unlock, or remove a Git worktree.
- If work needs isolation, use a separate ordinary branch in this same clone;
  only one branch may be checked out at a time.
- Do not mutate `.git` refs or WipStream operation receipts manually. Use the
  repository's workflow APIs or WipStream commands so exact leases,
  transactions, recovery refs, and receipts remain authoritative.
- Preserve user changes and inspect incomplete WipStream operations before
  starting another mutation.
