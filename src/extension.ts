import * as vscode from "vscode";
import { registerCommands } from "./registered-commands";

export function activate(context: vscode.ExtensionContext): void {
    registerCommands(context);
}

export function deactivate(): void {
    // VS Code disposes the registered Git-state event subscriptions.
}
