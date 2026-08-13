# Conventions

- Extension command ids are built from `EXTENSION_NAME` plus a suffix in `registerCommands`.
- Existing Git integration represents a subset of VS Code Git API locally in `src/git.ts`; extend that facade only as required by callers.
- Use `vscode.window` notifications for user-visible failures and command feedback; retrieve the repository for the active editor when possible.
- Existing source style: two-space indentation, semicolons, double-quoted strings.