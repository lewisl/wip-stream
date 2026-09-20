import * as vscode from "vscode";
import * as cmd from "./commands";
import {
    abortPendingMerge,
    continuePendingMerge,
    inspectPendingMerge,
    reconcileWithRemote,
} from "./conflict-workflow";
import { EXTENSION_NAME } from "./constants";
import { WipStreamError } from "./errors";
import {
    commitAndSave,
    getFromRemote,
    initializeRepository,
} from "./generalized-workflow";
import {
    CondensePreview,
    condenseBranch,
    startBranch,
    updateFromParent,
} from "./lifecycle-workflow";
import { readRepositoryConfiguration } from "./repository-model";
import { inspectUndoEligibility, undoLastAction } from "./undo-workflow";
import { inspectIncompleteOperations, renderOperationPreview } from "./operations";
import { recoverIncompleteOperation } from "./recovery-workflow";

type CommandAction = (
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
) => Promise<void>;

// Apply the progress, cancellation, error, and context-refresh policy shared by
// every command exposed by the extension.
async function runCommand(
    output: vscode.OutputChannel,
    title: string,
    cancellable: boolean,
    action: CommandAction
): Promise<void> {
    try {
        output.appendLine(`${new Date().toISOString()}  START  ${title}`);
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `WipStream: ${title}`,
                cancellable,
            },
            async (_progress, token) => {
                const controller = new AbortController();
                const subscription = token.onCancellationRequested(() => controller.abort());
                try {
                    await action(output, controller.signal);
                } finally {
                    subscription.dispose();
                }
            }
        );
    } catch (error) {
        await cmd.handleCommandError(output, title, error);
    } finally {
        await cmd.refreshActiveCommandContexts();
    }
}

function registerCommand(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    name: string,
    title: string,
    cancellable: boolean,
    action: CommandAction
): void {
    const handler = runCommand.bind(
        undefined,
        output,
        title,
        cancellable,
        action
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            EXTENSION_NAME + "." + name,
            handler
        )
    );
}

//
// commands registered and accessible in the extension
//
// Commands exposed by the extension.
async function initializeCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    await cmd.saveRepositoryDocuments(repo);

    const configuration = await readRepositoryConfiguration(repo);
    const requestedRemote = configuration.kind === "uninitialized"
        ? await cmd.askValue("Git remote", "origin")
        : undefined;
    const result = await initializeRepository(repo, requestedRemote);

    cmd.showSuccess(
        output,
        "Initialize Repository",
        `checkout=${result.checkout} published=${cmd.branchList(result.published)} created=${cmd.branchList(result.created)} fastForwarded=${cmd.branchList(result.fastForwarded)} deleted=${cmd.branchList(result.deleted)}`,
        result.operationId,
        `Repository initialized; “${result.checkout}” is checked out. Use Start Branch for new work, or select an existing work branch in your Git client.`
    );
}

async function resumeCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    cmd.assertNoDirtyDocuments(repo);
    const result = await getFromRemote(repo);
    cmd.appendAdvisories(output, result.advisories);

    cmd.showSuccess(
        output,
        "Get from Remote",
        `checkout=${result.checkout} created=${cmd.branchList(result.created)} fastForwarded=${cmd.branchList(result.fastForwarded)} deleted=${cmd.branchList(result.deleted)}`,
        result.operationId,
        result.updated
            ? `Remote branches retrieved; continuing on “${result.checkout}”.`
            : `Already current on “${result.checkout}”.`
    );
}

async function saveupCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    await cmd.reportSave(output, await commitAndSave(repo, cmd.saveHooks(repo)));
}

async function startBranchCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    const branch = await cmd.askValue("New branch name", "change");
    const result = await startBranch(repo, branch);

    cmd.showSuccess(
        output,
        "Start Branch",
        `branch=${result.branch} parent=${result.parent}`,
        result.operationId,
        `Started “${result.branch}” from “${result.parent}”.`
    );
}

async function finishBranchCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    await cmd.runFinish(output, repo);
}

async function updateCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    cmd.assertNoDirtyDocuments(repo);
    const result = await updateFromParent(repo, cmd.selectParent);
    if (result.pending && result.operationId) {
        await cmd.notifyPendingMerge(
            output,
            "Update from Parent",
            result.operationId,
            result.conflicts ?? []
        );
        return;
    }

    cmd.showSuccess(
        output,
        "Update from Parent",
        `branch=${result.branch} parent=${result.parent} updated=${result.updated}`,
        result.operationId,
        result.updated
            ? `Merged “${result.parent}” into “${result.branch}”.`
            : `“${result.branch}” already contains “${result.parent}”.`
    );
}

async function reconcileCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    cmd.assertNoDirtyDocuments(repo);
    const result = await reconcileWithRemote(repo, cmd.saveHooks(repo));
    if (result.pending) {
        await cmd.notifyPendingMerge(
            output,
            "Reconcile with Remote",
            result.operationId,
            result.conflicts
        );
        return;
    }

    output.appendLine(
        `${new Date().toISOString()}  SUCCESS  Reconcile with Remote operation=${result.operationId} branch=${result.branch} merged=true  next=automatic Commit and Save result follows`
    );
    if (result.save) await cmd.reportSave(output, result.save);
}

async function continueCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    await cmd.saveRepositoryDocuments(repo);
    const result = await continuePendingMerge(repo, cmd.saveHooks(repo));

    output.appendLine(
        `${new Date().toISOString()}  SUCCESS  Continue Pending Merge operation=${result.operationId} originalCommand=${result.command}  next=automatic Commit and Save result follows`
    );
    await cmd.reportSave(output, result.save);
}

async function abortCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    const pending = await inspectPendingMerge(repo);
    if (!pending) {
        throw new WipStreamError(
            "NO_PENDING_MERGE",
            "No WipStream merge is pending. Use Commit and Save to synchronize, or Recover Incomplete Operation if an interrupted attempt blocks it."
        );
    }

    if (await repo.operationInProgress()) {
        const confirmed = await vscode.window.showWarningMessage(
            `Abort ${pending.command} on “${pending.branch}” and restore its exact pre-merge state?`,
            { modal: true },
            "Abort Merge"
        );
        if (confirmed !== "Abort Merge") {
            throw new WipStreamError("CANCELLED", "Abort was cancelled.");
        }
    }

    const result = await abortPendingMerge(repo);
    cmd.showSuccess(
        output,
        "Abort Pending Merge",
        `restored=${result.restored} originalCommand=${result.command}`,
        result.operationId,
        result.restored
            ? `Aborted ${result.command}; the recorded pre-merge state is restored.`
            : "Git already completed this merge. Closed its stale WipStream record and kept your current work. Run Commit and Save to synchronize."
    );
}

async function recoverCommand(output: vscode.OutputChannel, networkSignal: AbortSignal): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    const incomplete = await inspectIncompleteOperations(repo);
    if (!incomplete.length) {
        throw new WipStreamError("NO_INCOMPLETE_OPERATION", "No WipStream operation needs recovery. Run Commit and Save to synchronize your work.");
    }
    const selected = incomplete.length === 1 ? incomplete[0] : (await vscode.window.showQuickPick(
        incomplete.map(receipt => ({
            label: receipt.plan.command,
            description: `${receipt.phase} (${receipt.plan.operationId})`,
            receipt,
        })),
        { placeHolder: "Select the interrupted operation to inspect" }
    ))?.receipt;
    if (!selected) return;
    const branch = await repo.currentBranch();
    const head = await repo.hash("HEAD");
    const active = await repo.operationInProgress();
    const conflicts = await repo.conflictPaths();
    const status = await repo.statusPorcelain();
    output.appendLine(renderOperationPreview(selected.plan));
    output.appendLine(`Recorded phase: ${selected.phase}`);
    if (selected.pendingMerge) {
        output.appendLine(`Recorded merge: ${selected.pendingMerge.branch} at ${selected.pendingMerge.preHead} with ${selected.pendingMerge.mergeTarget}`);
    }
    output.appendLine(`Current Git state: branch=${branch ?? "detached"} HEAD=${head} activeOperation=${active} conflicts=${conflicts.join(", ") || "none"}`);
    output.appendLine(`Working files:\n${status || "clean"}`);
    output.show(true);
    if (active || conflicts.length) {
        throw new WipStreamError("RECOVERY_BLOCKED", "Git still has an active operation or unresolved conflicts. Finish or abort it in your Git client; for a WipStream merge, use Continue Pending Merge or Abort Pending Merge. The current state is shown in WipStream Output.");
    }
    const confirmed = await vscode.window.showWarningMessage(
        `Keep current state and close the interrupted ${selected.plan.command} attempt?`,
        {
            modal: true,
            detail: `Operation: ${selected.plan.operationId}\nRecorded phase: ${selected.phase}\nCurrent branch: ${branch ?? "detached"}\nCurrent commit: ${head}\nGit has no active operation or unresolved conflicts.\n\nThis keeps your files, staged changes, commits, remote branches, and recovery history. It does not undo the old attempt or declare the remote synchronized. Run Commit and Save afterward.`,
        },
        "Keep Current State"
    );
    if (confirmed !== "Keep Current State") return;
    const receipt = await recoverIncompleteOperation(repo, selected.plan.operationId);
    cmd.showSuccess(output, "Recover Incomplete Operation", "preservedCurrentState=true", receipt.plan.operationId,
        "Kept your current files and commits and closed the interrupted attempt. Run Commit and Save to synchronize; recover any other incomplete attempts first.");
}

async function undoCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    const eligibility = await inspectUndoEligibility(repo);
    if (!eligibility.eligible || !eligibility.operationId) {
        throw new WipStreamError(
            "UNDO_NOT_ELIGIBLE",
            eligibility.reason ?? "The latest action is not undoable."
        );
    }

    const confirmed = await vscode.window.showWarningMessage(
        `Undo the exact completed WipStream action “${eligibility.command}” (${eligibility.operationId})?`,
        { modal: true },
        "Undo Action"
    );
    if (confirmed !== "Undo Action") {
        throw new WipStreamError("CANCELLED", "Undo was cancelled.");
    }

    const result = await undoLastAction(repo);
    cmd.showSuccess(
        output,
        "Undo Last Action",
        `undoneOperation=${result.undoneOperationId} command=${result.command} checkout=${result.restoredCheckout ?? "detached"}`,
        result.operationId,
        `Undid “${result.command}” and restored its exact recorded before-state.`
    );
}

async function condenseBranchCommand(
    output: vscode.OutputChannel,
    networkSignal: AbortSignal
): Promise<void> {
    const repo = await cmd.selectRepository(networkSignal);
    cmd.assertNoDirtyDocuments(repo);
    const result = await condenseBranch(repo, {
        selectParent: cmd.selectParent,
        confirmPreview: async (preview: CondensePreview) => (
            await vscode.window.showWarningMessage(
                `Replace ${preview.exclusiveCommits} commits exclusive to “${preview.branch}” with one tree-equivalent commit? Recovery refs and Undo will protect the prior tip.`,
                { modal: true },
                "Condense Branch"
            )
        ) === "Condense Branch",
        requestMessage: async (suggestedMessage) =>
            cmd.askValue("Condensed commit message", suggestedMessage),
    });

    cmd.showSuccess(
        output,
        "Condense Branch",
        `branch=${result.branch} parent=${result.parent} commits=${result.exclusiveCommits} old=${result.oldTip} new=${result.newTip}`,
        result.operationId,
        `Condensed ${result.exclusiveCommits} commits on “${result.branch}”.`
    );
}

//
// wrapper for all commands to be called by extension.ts
//
// Register the complete public command surface in one easy-to-scan list.
export function registerCommands(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("WipStream");
    context.subscriptions.push(output);

    registerCommand(context, output, "init", "Initialize Repository", true, initializeCommand);
    registerCommand(context, output, "resume", "Get from Remote", true, resumeCommand);
    registerCommand(context, output, "saveup", "Commit and Save", true, saveupCommand);
    registerCommand(context, output, "start", "Start Branch", false, startBranchCommand);
    registerCommand(context, output, "finish", "Finish Branch", true, finishBranchCommand);
    registerCommand(context, output, "update", "Update from Parent", true, updateCommand);
    registerCommand(context, output, "reconcile", "Reconcile with Remote", true, reconcileCommand);
    registerCommand(context, output, "continue", "Continue Pending Merge", true, continueCommand);
    registerCommand(context, output, "abort", "Abort Pending Merge", false, abortCommand);
    registerCommand(context, output, "recover", "Recover Incomplete Operation", false, recoverCommand);
    registerCommand(context, output, "undo", "Undo Last Action", true, undoCommand);
    registerCommand(context, output, "condense", "Condense Branch (Advanced)", true, condenseBranchCommand);

    cmd.registerContextRefresh(context);
}
