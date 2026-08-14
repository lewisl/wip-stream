import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_NAME } from "./constants";
import { GitRepository } from "./git";
import {
  defaultsFor,
  FinishResult,
  initialize,
  resume,
  saveUp,
  StreamConfigInput,
  SyncResult,
  toFeature,
  toMain,
  WipRewriteConfirmation,
  WorkflowError,
} from "./workflow";

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function repositoryCandidates(): Promise<GitRepository[]> {
  const candidates = new Map<string, GitRepository>();
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const paths: string[] = [];

  if (activeUri?.scheme === "file") {
    paths.push(path.dirname(activeUri.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    paths.push(folder.uri.fsPath);
  }

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

async function selectRepository(): Promise<GitRepository> {
  const candidates = await repositoryCandidates();
  if (candidates.length === 0) {
    throw new WorkflowError("NO_REPOSITORY", "No Git repository is available for the active editor or workspace.");
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const choice = await vscode.window.showQuickPick(
    candidates.map((repo) => ({ label: path.basename(repo.root), description: repo.root, repo })),
    { placeHolder: "Choose the repository WipStream should use" }
  );
  if (!choice) {
    throw new WorkflowError("CANCELLED", "WipStream command cancelled.");
  }
  return choice.repo;
}

function repositoryDocuments(repo: GitRepository): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (document) => document.uri.scheme === "file" && isWithin(repo.root, document.uri.fsPath)
  );
}

async function saveRepositoryDocuments(repo: GitRepository): Promise<void> {
  for (const document of repositoryDocuments(repo)) {
    if (document.isDirty && !(await document.save())) {
      throw new WorkflowError("SAVE_FAILED", `VS Code could not save ${path.relative(repo.root, document.uri.fsPath)}.`);
    }
  }
}

function assertNoDirtyDocuments(repo: GitRepository): void {
  const dirty = repositoryDocuments(repo).find((document) => document.isDirty);
  if (dirty) {
    throw new WorkflowError(
      "UNSAVED_EDITOR_WORK",
      `Unsaved editor work exists in ${path.relative(repo.root, dirty.uri.fsPath)}. Save, preserve, or discard it before resuming.`
    );
  }
}

async function askValue(prompt: string, value: string): Promise<string> {
  const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
  if (result === undefined) {
    throw new WorkflowError("CANCELLED", "WipStream command cancelled.");
  }
  if (!result.trim()) {
    throw new WorkflowError("INVALID_INPUT", "WipStream names cannot be blank.");
  }
  return result.trim();
}

async function promptForCheckpointMessage(defaultMessage: string): Promise<string> {
  const result = await vscode.window.showInputBox({
    prompt: "Checkpoint commit message",
    value: defaultMessage,
    ignoreFocusOut: true,
  });
  if (result === undefined) {
    throw new WorkflowError("CANCELLED", "WipStream command cancelled.");
  }
  if (!result.trim()) {
    throw new WorkflowError("INVALID_INPUT", "Checkpoint commit messages cannot be blank.");
  }
  return result.trim();
}

async function promptForConfig(repo: GitRepository): Promise<StreamConfigInput> {
  const defaults = await defaultsFor(repo);
  return {
    remote: await askValue("Git remote", defaults.remote),
    mainBranch: await askValue("Completed-work branch", defaults.mainBranch),
    featureBranch: await askValue("Accepted-feature branch", defaults.featureBranch),
    wipBranch: await askValue("Active WIP branch", defaults.wipBranch),
  };
}

function syncMessage(result: SyncResult): string {
  if (result.published) {
    if (result.wipHistoryRewritten) {
      return result.checkpointCreated ? "Rewritten WIP history saved and synced." : "Rewritten WIP history synced.";
    }
    return result.checkpointCreated ? "WIP checkpoint saved and synced." : "No committable changes; managed branches are synced.";
  }
  if (result.failure === "offline") {
    return result.checkpointCreated
      ? "WIP checkpoint saved locally but not synced. This machine still has the latest work."
      : "No committable changes, but pending work could not be synced. This machine may still have the latest work.";
  }
  return result.checkpointCreated
    ? "WIP checkpoint is local only because the remote contains different work. Do not continue on another machine until you recover or publish it."
    : "No committable changes, but managed branches are local only because the remote contains different work. Do not continue on another machine until you recover or publish it.";
}

async function confirmWipRewrite({ unverifiedBase }: WipRewriteConfirmation): Promise<boolean> {
  const message = unverifiedBase
    ? "WipStream cannot verify the earlier handoff because this stream was initialized with an older version. Replace the remote WIP checkpoints only if no other machine has worked on this stream since you last saved."
    : "WipStream detected that unaccepted WIP checkpoints were rewritten locally. Replace the remote WIP checkpoints with this condensed history?";
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Replace Remote WIP");
  return choice === "Replace Remote WIP";
}

function showSuccess(output: vscode.OutputChannel, message: string, notification = message): void {
  output.appendLine(`${new Date().toISOString()}  SUCCESS  ${message}`);
  output.show(true);
  void vscode.window.showInformationMessage(`WipStream: ${notification}`);
}

function showError(output: vscode.OutputChannel, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`${new Date().toISOString()}  ERROR  ${message}`);
  output.show(true);
  if (error instanceof WorkflowError && error.code === "CANCELLED") {
    vscode.window.showInformationMessage(message);
    return;
  }
  vscode.window.showErrorMessage(`WipStream: ${message}`);
}

async function runCommand(output: vscode.OutputChannel, title: string, action: () => Promise<void>): Promise<void> {
  try {
    output.appendLine(`${new Date().toISOString()}  START  ${title}`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `WipStream: ${title}`, cancellable: false },
      action
    );
  } catch (error) {
    showError(output, error);
  }
}

export function registerCommands(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("WipStream");
  context.subscriptions.push(output);

  const register = (name: string, handler: () => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(`${EXTENSION_NAME}.${name}`, handler));
  };

  register("init", () =>
    runCommand(output, "Initialize Stream", async () => {
      const repo = await selectRepository();
      await saveRepositoryDocuments(repo);
      const result = await initialize(repo, await promptForConfig(repo));
      const branch = await repo.currentBranch();
      const initialized = result === "created"
        ? "WipStream initialized."
        : result === "attached"
          ? "Existing WipStream attached."
          : "WipStream was already initialized.";
      const message = `${initialized} Get Current from Remote completed; editing “${branch ?? "the WIP branch"}”. Start every later editing session with WipStream: Get Current from Remote.`;
      showSuccess(output, message, `Remote is current; editing “${branch ?? "the WIP branch"}”.`);
    })
  );

  register("resume", () =>
    runCommand(output, "Get Current from Remote", async () => {
      const repo = await selectRepository();
      assertNoDirtyDocuments(repo);
      const result = await resume(repo);
      const message = result === "resumed"
        ? "Latest WipStream work loaded; you are now editing wip/feature."
        : result === "completed"
          ? "A feature was completed on another machine. Main is now current and temporary branches were removed. Run Initialize Stream to start the next feature."
          : "WipStream is already current; you are editing wip/feature.";
      showSuccess(output, message);
    })
  );

  register("saveup", () =>
    runCommand(output, "Save to Remote", async () => {
      const repo = await selectRepository();
      await saveRepositoryDocuments(repo);
      showSuccess(output, syncMessage(await saveUp(repo, promptForCheckpointMessage, confirmWipRewrite)));
    })
  );

  register("tofeature", () =>
    runCommand(output, "To Feature", async () => {
      const repo = await selectRepository();
      await saveRepositoryDocuments(repo);
      const saved = await saveUp(repo, promptForCheckpointMessage, confirmWipRewrite);
      if (!saved.published) {
        throw new WorkflowError("NOT_SYNCED", `${syncMessage(saved)} To Feature requires a successful handoff.`);
      }
      const moved = await toFeature(repo);
      showSuccess(output, moved ? "WIP commits are now accepted on feature and synced." : "Feature already contains the current WIP commits.");
    })
  );

  register("tomain", () =>
    runCommand(output, "To Main", async () => {
      const repo = await selectRepository();
      await saveRepositoryDocuments(repo);
      const result: FinishResult = await toMain(repo);
      showSuccess(output, result === "finished" ? "Feature completed on main and temporary branches removed." : "Feature was already completed; local cleanup is finished.");
    })
  );
}
