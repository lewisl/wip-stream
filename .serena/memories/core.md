# Core

- VS Code TypeScript extension for a deliberate WIP handoff workflow.
- Entrypoint: `src/extension.ts`; commands: `src/commands.ts`; Git CLI facade: `src/git.ts`. The extension has no background watcher or persistent process.
- Uses VS Code built-in Git extension API v1 obtained with `vscode.extensions.getExtension("vscode.git")`.
- Read `mem:tech_stack` for tooling, `mem:conventions` for current source patterns, and `mem:task_completion` before handing off code changes.