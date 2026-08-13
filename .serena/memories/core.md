# Core

- VS Code TypeScript extension baseline, currently cloned from GitDoc.
- Entrypoint: `src/extension.ts`; commands: `src/commands.ts`; Git API facade: `src/git.ts`; legacy auto-commit watcher: `src/watcher.ts`.
- Uses VS Code built-in Git extension API v1 obtained with `vscode.extensions.getExtension("vscode.git")`.
- Read `mem:tech_stack` for tooling, `mem:conventions` for current source patterns, and `mem:task_completion` before handing off code changes.