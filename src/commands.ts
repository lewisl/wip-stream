import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "./constants";
import { errorCode, WipStreamError } from "./errors";
import { isWithin } from "./paths";
import { inspectPendingMerge } from "./conflict-workflow";
import {
    CommitAndSaveHooks,
    CommitAndSaveResult,
    ParentAdvisory,
} from "./generalized-workflow";
import { GitError, GitRepository } from "./git";
import {
    FinishBranchDisposition,
    FinishBranchPreview,
    finishBranch,
} from "./lifecycle-workflow";
import {
    readRepositoryConfiguration,
    resolveRemoteTrackingDefaultBranch,
} from "./repository-model";
import { inspectIncompleteOperations } from "./operations";
import { inspectUndoEligibility } from "./undo-workflow";
import type { SetupEditorState } from "./setup-workflow";

const CONTEXT_KEYS = [
    "wipstream.undoAvailable",
    "wipstream.condenseAvailable",
] as const;

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

export function readRepositoryEditorState(repo: GitRepository): SetupEditorState {
    const documents = repositoryDocuments(repo).map(document => ({
        path: document.uri.fsPath,
        version: document.version,
        dirty: document.isDirty,
    })).sort((left, right) => left.path.localeCompare(right.path));
    return {
        signature: JSON.stringify(documents),
        dirty: documents.some(document => document.dirty),
    };
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

async function chooseFinishDisposition({ branch, parent }: FinishBranchPreview): Promise<FinishBranchDisposition | undefined> {
    const choice = await vscode.window.showWarningMessage(
        `Finish “${branch}” into “${parent}”?`,
        { modal: true, detail: `WipStream will first Commit and Save, then advance “${parent}” locally and remotely and check it out. Retain “${branch}”, or delete that completed branch locally and remotely?` },
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
        const pending = await inspectPendingMerge(repo);
        if (pending) return;

        await setContext("wipstream.undoAvailable", (await inspectUndoEligibility(repo)).eligible);
        const branch = await repo.currentBranch();
        if (!branch) return;
        const remoteDefault = await resolveRemoteTrackingDefaultBranch(repo, configuration.remote);
        const isFeatureBranch = branch !== remoteDefault;
        await setContext("wipstream.condenseAvailable", isFeatureBranch);
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
                `Network activity was cancelled with incomplete operations: ${incomplete.map(receipt => receipt.plan.operationId).join(", ")}. Inspect them before continuing.`
            )
            : new WipStreamError("CANCELLED", `${title} was cancelled before an operation began.`));
    } else {
        await showError(output, error);
    }
}

export async function refreshActiveCommandContexts(): Promise<void> {
    await refreshCommandContexts(activeRepository);
}

interface GitStateRepository {
    readonly state: { onDidChange: vscode.Event<void> };
}

interface GitStateAPI {
    readonly repositories: readonly GitStateRepository[];
    readonly onDidOpenRepository: vscode.Event<GitStateRepository>;
    readonly onDidCloseRepository: vscode.Event<GitStateRepository>;
}

interface GitStateExtension {
    getAPI(version: 1): GitStateAPI;
}

/** Follow VS Code's Git state events, including changes made in other clients. */
export function registerContextRefresh(context: vscode.ExtensionContext): void {
    let disposed = false;
    let requested = false;
    let running = false;
    const refresh = async (): Promise<void> => {
        requested = true;
        if (running || disposed) return;
        running = true;
        try {
            while (requested && !disposed) {
                requested = false;
                await refreshActiveCommandContexts();
            }
        } catch {
            // Advisory context must never prevent a command from being invoked.
        } finally {
            running = false;
        }
    };
    const subscriptions = new Map<GitStateRepository, vscode.Disposable>();
    context.subscriptions.push(new vscode.Disposable(() => {
        disposed = true;
        for (const subscription of subscriptions.values()) subscription.dispose();
        subscriptions.clear();
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        activeRepository = undefined;
        void refresh();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        activeRepository = undefined;
        void refresh();
    }));
    context.subscriptions.push(vscode.window.onDidChangeWindowState(state => {
        if (state.focused) void refresh();
    }));
    const extension = vscode.extensions.getExtension<GitStateExtension>("vscode.git");
    if (extension) {
        void Promise.resolve(extension.activate()).then(exports => {
            if (disposed) return;
            const api = exports.getAPI(1);
            const watch = (repo: GitStateRepository): void => {
                if (!subscriptions.has(repo)) subscriptions.set(repo, repo.state.onDidChange(() => { void refresh(); }));
                void refresh();
            };
            for (const repo of api.repositories) watch(repo);
            context.subscriptions.push(api.onDidOpenRepository(watch));
            context.subscriptions.push(api.onDidCloseRepository(repo => {
                subscriptions.get(repo)?.dispose();
                subscriptions.delete(repo);
                activeRepository = undefined;
                void refresh();
            }));
        }).catch(() => { /* Git may be disabled; commands still inspect their repository directly. */ });
    }
    void refresh();
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
    if (action && choice === action) await vscode.commands.executeCommand(`${EXTENSION_NAME}.reconcile`);
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
