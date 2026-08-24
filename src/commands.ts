import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "./constants";
import { WipStreamError } from "./errors";
import { inspectPendingMerge } from "./conflict-workflow";
import {
    CommitAndSaveHooks,
    CommitAndSaveResult,
    ParentAdvisory,
} from "./generalized-workflow";
import { GitError, GitRepository } from "./git";
import {
    FinishBranchDisposition,
    finishBranch,
} from "./lifecycle-workflow";
import {
    getBranchParent,
    readRepositoryConfiguration,
    resolveRemoteTrackingDefaultBranch,
} from "./repository-model";
import { inspectIncompleteOperations } from "./operations";
import { inspectUndoEligibility } from "./undo-workflow";

const CONTEXT_KEYS = [
    "wipstream.initialized",
    "wipstream.finishAvailable",
    "wipstream.updateAvailable",
    "wipstream.reconcileAvailable",
    "wipstream.pendingMerge",
    "wipstream.undoAvailable",
    "wipstream.condenseAvailable",
] as const;

function isWithin(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

function operationDetail(operationId: string | undefined): string {
    return operationId ? ` operation=${operationId}` : "";
}

export function branchList(branches: readonly string[]): string {
    return branches.length ? branches.join(", ") : "none";
}

async function repositoryCandidates(): Promise<GitRepository[]> {
    const candidates = new Map<string, GitRepository>();
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const paths: string[] = [];
    if (activeUri?.scheme === "file") paths.push(path.dirname(activeUri.fsPath));
    for (const folder of vscode.workspace.workspaceFolders || []) paths.push(folder.uri.fsPath);

    for (const candidate of paths) {
        try {
            const repo = await GitRepository.open(candidate);
            candidates.set(repo.root, repo);
        } catch {
            // A workspace folder need not itself be a Git repository.
        }
    }
    return [...candidates.values()];
}

let activeRepository: GitRepository | undefined;

export async function selectRepository(networkSignal?: AbortSignal): Promise<GitRepository> {
    const candidates = await repositoryCandidates();
    if (candidates.length === 0) {
        throw new WipStreamError("NO_REPOSITORY", "No Git repository is available for the active editor or workspace.");
    }
    if (candidates.length === 1) {
        activeRepository = candidates[0];
        return networkSignal ? candidates[0].withNetworkCancellation(networkSignal) : candidates[0];
    }
    const choice = await vscode.window.showQuickPick(
        candidates.map((repo) => ({ label: path.basename(repo.root), description: repo.root, repo })),
        { placeHolder: "Choose the repository WipStream should use" }
    );
    if (!choice) throw new WipStreamError("CANCELLED", "WipStream command cancelled.");
    activeRepository = choice.repo;
    return networkSignal ? choice.repo.withNetworkCancellation(networkSignal) : choice.repo;
}

function repositoryDocuments(repo: GitRepository): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter(
        (document) => document.uri.scheme === "file" && isWithin(repo.root, document.uri.fsPath)
    );
}

export async function saveRepositoryDocuments(repo: GitRepository): Promise<void> {
    for (const document of repositoryDocuments(repo)) {
        if (document.isDirty && !(await document.save())) {
            throw new WipStreamError(
                "SAVE_FAILED",
                `VS Code could not save ${path.relative(repo.root, document.uri.fsPath)}.`
            );
        }
    }
}

export function assertNoDirtyDocuments(repo: GitRepository): void {
    const dirty = repositoryDocuments(repo).find((document) => document.isDirty);
    if (dirty) {
        throw new WipStreamError(
            "UNSAVED_EDITOR_WORK",
            `Unsaved editor work exists in ${path.relative(repo.root, dirty.uri.fsPath)}. Save it before retrieving remote files.`
        );
    }
}

export async function askValue(prompt: string, value: string): Promise<string> {
    const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
    if (result === undefined) throw new WipStreamError("CANCELLED", "WipStream command cancelled.");
    if (!result.trim()) throw new WipStreamError("INVALID_INPUT", "WipStream names cannot be blank.");
    return result.trim();
}

async function promptForCheckpointMessage(defaultMessage: string): Promise<string> {
    return askValue("Checkpoint commit message", defaultMessage);
}

export async function selectParent(assumedParent: string): Promise<string | undefined> {
    return askValue("Confirm or replace the parent branch", assumedParent);
}

async function chooseFinishDisposition(): Promise<FinishBranchDisposition | undefined> {
    const choice = await vscode.window.showWarningMessage(
        "Finish will advance the parent to this branch. Retain the completed branch name or delete it locally and remotely?",
        { modal: true },
        "Retain Branch",
        "Delete Branch"
    );
    return choice === "Retain Branch" ? "retain" : choice === "Delete Branch" ? "delete" : undefined;
}

export function saveHooks(repo: GitRepository): CommitAndSaveHooks {
    return {
        saveDocuments: () => saveRepositoryDocuments(repo),
        requestCheckpointMessage: promptForCheckpointMessage,
    };
}

export function appendAdvisories(output: vscode.OutputChannel, advisories: readonly ParentAdvisory[]): void {
    for (const advisory of advisories.filter(({ state }) => state !== "current")) {
        output.appendLine(
            `  ADVISORY branch=${advisory.branch} parent=${advisory.parent} state=${advisory.state} source=${advisory.source}`
        );
    }
}

export function showSuccess(
    output: vscode.OutputChannel,
    command: string,
    message: string,
    operationId?: string,
    notification = message
): void {
    output.appendLine(
        `${new Date().toISOString()}  SUCCESS  ${command}${operationDetail(operationId)}  ${message}  next=${notification}`
    );
    output.show(true);
    void vscode.window.showInformationMessage(`WipStream: ${notification}`);
}

async function showError(output: vscode.OutputChannel, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    output.appendLine(`${new Date().toISOString()}  ERROR${code ? ` code=${code}` : ""}  ${message}`);
    output.show(true);
    if (code === "CANCELLED") {
        await vscode.window.showInformationMessage(message);
        return;
    }
    if (code === "PARENT_UPDATE_REQUIRED") {
        const choice = await vscode.window.showWarningMessage(`WipStream: ${message}`, "Update from Parent");
        if (choice) await vscode.commands.executeCommand(`${EXTENSION_NAME}.update`);
        return;
    }
    await vscode.window.showErrorMessage(`WipStream: ${message}`);
}

async function setContext(key: typeof CONTEXT_KEYS[number], value: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", key, value);
}

async function refreshCommandContexts(preferred?: GitRepository): Promise<void> {
    for (const key of CONTEXT_KEYS) await setContext(key, false);
    let repo = preferred;
    if (!repo) {
        const candidates = await repositoryCandidates();
        repo = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (!repo) return;

    try {
        const configuration = await readRepositoryConfiguration(repo);
        if (configuration.kind !== "initialized") return;
        await setContext("wipstream.initialized", true);
        const pending = await inspectPendingMerge(repo);
        await setContext("wipstream.pendingMerge", Boolean(pending));
        if (pending) return;

        await setContext("wipstream.undoAvailable", (await inspectUndoEligibility(repo)).eligible);
        const branch = await repo.currentBranch();
        if (!branch) return;
        const remoteDefault = await resolveRemoteTrackingDefaultBranch(repo, configuration.remote);
        const isFeatureBranch = branch !== remoteDefault;
        await setContext("wipstream.finishAvailable", isFeatureBranch);
        await setContext("wipstream.condenseAvailable", isFeatureBranch);

        const remoteRef = repo.remoteTrackingRef(configuration.remote, branch);
        if (await repo.refExists(remoteRef)) {
            await setContext(
                "wipstream.reconcileAvailable",
                (await repo.relation(repo.localRef(branch), remoteRef)) === "diverged"
            );
        }
        const parent = await getBranchParent(repo, branch) ?? remoteDefault;
        if (parent !== branch && await repo.branchExists(parent)) {
            const parentContainsBranch = await repo.isAncestor(repo.localRef(branch), repo.localRef(parent));
            const branchContainsParent = await repo.isAncestor(repo.localRef(parent), repo.localRef(branch));
            await setContext("wipstream.updateAvailable", !parentContainsBranch && !branchContainsParent);
        }
    } catch {
        // Context is advisory. Command preflights remain authoritative.
    }
}

export async function handleCommandError(
    output: vscode.OutputChannel,
    title: string,
    error: unknown
): Promise<void> {
    if (error instanceof GitError && error.cancelled) {
        const incomplete = activeRepository
            ? await inspectIncompleteOperations(activeRepository)
            : [];
        await showError(output, incomplete.length
            ? new WipStreamError(
                "INCOMPLETE_WIPSTREAM_OPERATION",
                `Network activity was cancelled during operation “${incomplete[0].plan.operationId}”. Inspect it before continuing.`
            )
            : new WipStreamError("CANCELLED", `${title} was cancelled before an operation began.`));
    } else {
        await showError(output, error);
    }
}

export async function refreshActiveCommandContexts(): Promise<void> {
    await refreshCommandContexts(activeRepository);
}

export async function reportSave(output: vscode.OutputChannel, result: CommitAndSaveResult): Promise<void> {
    appendAdvisories(output, result.advisories);
    if (result.published) {
        showSuccess(
            output,
            "Commit and Save",
            `checkout=${result.checkout} checkpoint=${result.checkpointCreated} published=${branchList(result.publishedBranches)}; remote handoff is complete`,
            result.operationId,
            result.checkpointCreated ? "Checkpoint committed and all branches synchronized." : "All branches are synchronized."
        );
        return;
    }
    output.appendLine(
        `${new Date().toISOString()}  WARNING  Commit and Save${operationDetail(result.operationId)}  ${result.message}`
    );
    output.show(true);
    const action = result.reconcileBranch ? "Reconcile with Remote" : undefined;
    const choice = action
        ? await vscode.window.showWarningMessage(`WipStream: ${result.message}`, action)
        : await vscode.window.showWarningMessage(`WipStream: ${result.message}`);
    if (choice === action) await vscode.commands.executeCommand(`${EXTENSION_NAME}.reconcile`);
}

export async function notifyPendingMerge(
    output: vscode.OutputChannel,
    command: string,
    operationId: string,
    conflicts: readonly string[]
): Promise<void> {
    output.appendLine(
        `${new Date().toISOString()}  PENDING  ${command} operation=${operationId} conflicts=${branchList(conflicts)}  next=resolve the listed paths and Continue, or Abort`
    );
    output.show(true);
    const choice = await vscode.window.showWarningMessage(
        `WipStream merge needs attention${conflicts.length ? ` in ${conflicts.join(", ")}` : ""}.`,
        "Continue",
        "Abort"
    );
    if (choice === "Continue") await vscode.commands.executeCommand(`${EXTENSION_NAME}.continue`);
    if (choice === "Abort") await vscode.commands.executeCommand(`${EXTENSION_NAME}.abort`);
}

export async function runFinish(output: vscode.OutputChannel, repo: GitRepository): Promise<void> {
    const result = await finishBranch(repo, {
        save: saveHooks(repo),
        selectParent,
        chooseDisposition: chooseFinishDisposition,
    });
    showSuccess(
        output,
        "Finish Branch",
        `branch=${result.branch} parent=${result.parent} disposition=${result.disposition}`,
        result.operationId,
        `Finished “${result.branch}” into “${result.parent}” and ${result.disposition === "delete" ? "deleted" : "retained"} the branch.`
    );
}
