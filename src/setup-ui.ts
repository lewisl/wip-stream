import * as path from "path";
import * as vscode from "vscode";
import * as cmd from "./commands";
import { GitRepository } from "./git";
import {
    executeRepositorySetup,
    inspectRepositorySetup,
    SetupChoice,
    SetupInspection,
    SetupResult,
} from "./setup-workflow";

const OPEN_BACKUP = "Open Backup Folder";
const REVIEW_SETUP = "Review Updated Setup";

interface AuthorityItem extends vscode.QuickPickItem {
    readonly choiceKind: SetupChoice["kind"];
}

function appendInspection(output: vscode.OutputChannel, inspection: SetupInspection): void {
    output.appendLine(`Setup preview: remote=${inspection.remote} default=${inspection.remoteDefaultBranch} checkout=${inspection.local.checkout ?? "detached"}`);
    output.appendLine("Synchronization covers all ordinary branches, not only the checked-out branch:");
    for (const branch of inspection.branches) {
        output.appendLine(`  ${branch.name}: ${branch.relation}`);
    }
    output.appendLine(`Working files:\n${inspection.local.status || "clean"}`);
    output.appendLine(`Unsaved file-backed editor documents: ${inspection.local.editors.dirty ? "yes" : "no"}`);
    output.show(true);
}

async function openBackupIfChosen(action: string | undefined, backupPath?: string): Promise<void> {
    if (action === OPEN_BACKUP && backupPath) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(backupPath), true);
    }
}

function showSetupNotification(
    output: vscode.OutputChannel,
    kind: "information" | "warning",
    message: string,
    backupPath?: string
): void {
    const detail = backupPath ? `${message} Backup folder: ${backupPath}.` : message;
    const actions = backupPath ? [OPEN_BACKUP] : [];
    const notification = kind === "warning"
        ? vscode.window.showWarningMessage(`WipStream: ${detail}`, ...actions)
        : vscode.window.showInformationMessage(`WipStream: ${detail}`, ...actions);
    // A terminal notice is not another setup decision. Let command progress
    // finish while retaining the optional action for a later user click.
    void Promise.resolve(notification)
        .then(action => openBackupIfChosen(action, backupPath))
        .catch(error => cmd.handleCommandError(output, "Setup Notification", error));
}

async function chooseRemoteBackup(repo: GitRepository, inspection: SetupInspection, signal: AbortSignal): Promise<SetupChoice> {
    const localOnly = inspection.branches.filter(branch => branch.localTip && !branch.fetchedRemoteTip).map(branch => branch.name);
    const detail = `The selected remote “${inspection.remote}” becomes authoritative for ALL ordinary branches. Local branches will match its exact commits; missing branches will be created and local-only branches removed (${cmd.branchList(localOnly)}). Tracked files will be replaced and non-ignored untracked files removed. Ignored files are preserved; collisions stop replacement. The final checkout is “${inspection.remoteDefaultBranch}”. No push, merge, or content commit is made. Undo Last Action cannot restore discarded uncommitted files.`;
    // Modal messages already supply a Cancel button; do not add a second one.
    const action = await vscode.window.showWarningMessage(
        "Use the remote’s version of this project?",
        { modal: true, detail },
        "Copy project, then use remote",
        "Use remote without a backup"
    );
    if (signal.aborted) return { kind: "cancel" };
    if (action === "Copy project, then use remote") {
        const folders = await vscode.window.showOpenDialog({
            title: "Choose a parent folder for the complete project backup",
            defaultUri: vscode.Uri.file(path.dirname(repo.root)),
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Choose Backup Parent",
        });
        if (!folders?.length || signal.aborted) return { kind: "cancel" };
        return { kind: "remote", backup: { kind: "copy", parent: folders[0].fsPath } };
    }
    if (action === "Use remote without a backup") {
        const confirmation = await vscode.window.showWarningMessage(
            "Replace local work without a project backup?",
            {
                modal: true,
                detail: `${detail}\n\nNo complete backup will be created. Unsaved documents are saved before proceeding and may require a new preview. Replaced tracked changes and removed non-ignored untracked files will not be recoverable through WipStream Undo. Cancel if any local work must be retained.`,
            },
            "Discard Local Work and Use Remote"
        );
        if (confirmation === "Discard Local Work and Use Remote" && !signal.aborted) {
            return { kind: "remote", backup: { kind: "discard", confirmed: true } };
        }
    }
    return { kind: "cancel" };
}

async function chooseAuthority(repo: GitRepository, inspection: SetupInspection, signal: AbortSignal): Promise<SetupChoice> {
    const choices: AuthorityItem[] = [
        {
            label: "Use the remote’s version",
            detail: "Match all ordinary branches and working files to the remote. Choose a complete backup or explicitly confirm discard. Never pushes or makes a commit.",
            choiceKind: "remote",
        },
        {
            label: "Commit this machine’s work and save to remote",
            detail: "Save editor documents, checkpoint changes, and synchronize all ordinary branches. Divergence keeps the checkpoint locally and publishes nothing.",
            choiceKind: "local-work",
        },
        {
            label: "Resolve differences locally, then save to remote",
            detail: "Keep current work, reconcile the affected histories in your Git tool, then rerun Initialize and choose this machine’s work.",
            choiceKind: "reconcile",
        },
        { label: "Cancel", choiceKind: "cancel" },
    ];
    const selected = await vscode.window.showQuickPick(choices, {
        title: "Initialize Repository: Choose authoritative work",
        placeHolder: `All ordinary branches on “${inspection.remote}”; final checkout “${inspection.remoteDefaultBranch}”. Details are in WipStream Output.`,
        ignoreFocusOut: true,
    });
    if (!selected || selected.choiceKind === "cancel" || signal.aborted) return { kind: "cancel" };
    if (selected.choiceKind === "remote") return chooseRemoteBackup(repo, inspection, signal);
    return { kind: selected.choiceKind };
}

async function reportCompleted(output: vscode.OutputChannel, result: Extract<SetupResult, { kind: "completed" }>, choice: SetupChoice): Promise<void> {
    output.appendLine(`${new Date().toISOString()}  SUCCESS  Initialize Repository operation=${result.operationId} checkout=${result.checkout} checkpointCreated=${result.checkpointCreated} published=${result.published} publishedBranches=${cmd.branchList(result.publishedBranches)} created=${cmd.branchList(result.created)} fastForwarded=${cmd.branchList(result.fastForwarded)} replaced=${cmd.branchList(result.replaced ?? [])} deleted=${cmd.branchList(result.deleted)}${result.backupPath ? ` backup=${result.backupPath}` : ""}`);
    output.show(true);
    const message = choice.kind === "remote"
        ? `Repository initialized from the remote across all ordinary branches; “${result.checkout}” is checked out. Nothing was pushed and no content commit was created. Undo cannot restore replaced uncommitted files.`
        : `Repository initialized and all ordinary branches synchronized; “${result.checkout}” is checked out.${result.checkpointCreated ? " This machine’s changes were checkpointed and saved to the remote." : ""} Use Start Branch for new work, or select an existing work branch in your Git client.`;
    showSetupNotification(output, "information", message, result.backupPath);
}

async function reportCancelled(output: vscode.OutputChannel, executionStarted: boolean, checkpointCreated: boolean): Promise<void> {
    const message = checkpointCreated
        ? "Setup cancelled. The checkpoint created earlier is saved locally; remote saving has not completed."
        : executionStarted
            ? "Setup cancelled; current files and commits are retained. Remote saving has not completed."
            : "Setup cancelled; no editor documents were saved, files replaced, or work published by this attempt.";
    output.appendLine(`${new Date().toISOString()}  CANCELLED  Initialize Repository  ${message}`);
    showSetupNotification(output, "information", message);
}

/** Dialogs only choose authority; the workflow owns saving, locking, and mutation. */
export async function runRepositorySetup(
    output: vscode.OutputChannel,
    repo: GitRepository,
    requestedRemote: string | undefined,
    signal: AbortSignal
): Promise<void> {
    const hooks = {
        ...cmd.saveHooks(repo),
        readEditorState: () => cmd.readRepositoryEditorState(repo),
        signal,
    };
    let requireNewChoice = false;
    let executionStarted = false;
    let checkpointCreated = false;
    while (true) {
        if (signal.aborted) return reportCancelled(output, executionStarted, checkpointCreated);
        const inspection = await inspectRepositorySetup(repo, requestedRemote, hooks);
        appendInspection(output, inspection);
        if (signal.aborted) return reportCancelled(output, executionStarted, checkpointCreated);
        let choice: SetupChoice = { kind: "local-work" };
        if (inspection.requiresChoice || requireNewChoice) {
            choice = await chooseAuthority(repo, inspection, signal);
        }
        if (choice.kind === "cancel" || signal.aborted) {
            return reportCancelled(output, executionStarted, checkpointCreated);
        }
        executionStarted = true;
        const result = await executeRepositorySetup(repo, inspection, choice, hooks);
        checkpointCreated = checkpointCreated || result.checkpointCreated;
        if (result.kind === "completed") return reportCompleted(output, result, choice);

        const state = result.kind === "cancelled" ? "CANCELLED" : "INCOMPLETE";
        output.appendLine(`${new Date().toISOString()}  ${state}  Initialize Repository${result.kind === "failed" && result.operationId ? ` operation=${result.operationId}` : ""} checkpointCreated=${result.checkpointCreated} remoteSavingCompleted=false  ${result.message}`);
        output.show(true);
        if (result.kind === "cancelled") {
            showSetupNotification(output, "information", result.message, result.backupPath);
            return;
        }
        if (result.kind !== "preview-required" || signal.aborted) {
            showSetupNotification(output, "warning", result.message, result.backupPath);
            return;
        }
        const actions = [REVIEW_SETUP];
        if (result.backupPath) actions.push(OPEN_BACKUP);
        const action = await vscode.window.showWarningMessage(`WipStream: ${result.message}`, ...actions);
        await openBackupIfChosen(action, result.backupPath);
        if (action === REVIEW_SETUP && !signal.aborted) {
            // Approval of an older authority/backup choice never carries over.
            requireNewChoice = true;
            continue;
        }
        return;
    }
}

export async function reportSetupRecovery(
    output: vscode.OutputChannel,
    operationId: string,
    backupPath?: string
): Promise<void> {
    const message = "Kept your current files and commits and closed the interrupted attempt. No backup was restored and no remote synchronization is claimed. Recover any other incomplete attempts, then rerun Initialize Repository for a fresh preview.";
    output.appendLine(`${new Date().toISOString()}  SUCCESS  Recover Incomplete Operation operation=${operationId} preservedCurrentState=true${backupPath ? ` backup=${backupPath}` : ""}  ${message}`);
    output.show(true);
    showSetupNotification(output, "information", message, backupPath);
}
