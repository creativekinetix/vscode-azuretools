/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IActionContext, UserCancelledError } from 'vscode-azureextensionui';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { ScmType } from '../ScmType';
import { isPathEqual, isSubpath } from '../utils/pathUtils';

export async function runPreDeployTask(context: IActionContext, deployFsPath: string, scmType: string | undefined): Promise<void> {
    const preDeployResult: IPreDeployTaskResult = await tryRunPreDeployTask(context, deployFsPath, scmType);
    if (preDeployResult.failedToFindTask) {
        throw new Error(`Failed to find pre-deploy task "${preDeployResult.taskName}". Modify your tasks or the setting "${ext.prefix}.preDeployTask".`);
    } else if (preDeployResult.exitCode !== undefined && preDeployResult.exitCode !== 0) {
        await handleFailedPreDeployTask(context, preDeployResult);
    }
}

export async function tryRunPreDeployTask(context: IActionContext, deployFsPath: string, scmType: string | undefined): Promise<IPreDeployTaskResult> {
    const preDeployTaskKey: string = 'preDeployTask';
    const taskName: string | undefined = vscode.workspace.getConfiguration(ext.prefix, vscode.Uri.file(deployFsPath)).get(preDeployTaskKey);
    context.telemetry.properties.hasPreDeployTask = String(!!taskName);

    let preDeployTaskResult: IPreDeployTaskResult = { taskName, exitCode: undefined, failedToFindTask: false };

    if (taskName) {
        if (scmType === ScmType.LocalGit || scmType === ScmType.GitHub) {
            // We don't run pre deploy tasks for non-zipdeploy since that stuff should be handled by kudu
            ext.outputChannel.appendLog(localize('ignoringPreDeployTask', 'WARNING: Ignoring preDeployTask "{0}" for non-zip deploy.', taskName));
        } else {
            const tasks: vscode.Task[] = await vscode.tasks.fetchTasks();
            const taskNameWithoutSource: string = taskName.replace(/^[^:]*:\s*/, '');
            // First, search for an exact match. If that doesn't work, search for a task without the source in the name (e.g. if taskName is "func: extensions install", search for just "extensions install")
            const preDeployTask: vscode.Task | undefined = tasks.find((task: vscode.Task) => isTaskEqual(taskName, deployFsPath, task))
                || tasks.find((task: vscode.Task) => isTaskEqual(taskNameWithoutSource, deployFsPath, task));

            if (preDeployTask) {
                const progressMessage: string = localize('runningTask', 'Running preDeployTask "{0}"...', taskName);
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: progressMessage }, async () => {
                    await vscode.tasks.executeTask(preDeployTask);
                    preDeployTaskResult = await waitForPreDeployTask(preDeployTask, deployFsPath);
                    context.telemetry.properties.preDeployTaskExitCode = String(preDeployTaskResult.exitCode);
                });
            } else {
                preDeployTaskResult.failedToFindTask = true;
            }
        }
    }

    return preDeployTaskResult;
}

export interface IPreDeployTaskResult {
    taskName: string | undefined;
    exitCode: number | undefined;
    failedToFindTask: boolean;
}

function isTaskEqual(expectedName: string, expectedPath: string, actualTask: vscode.Task): boolean {
    if (expectedName.toLowerCase() === actualTask.name.toLowerCase() && actualTask.scope !== undefined) {
        const workspaceFolder: Partial<vscode.WorkspaceFolder> = <Partial<vscode.WorkspaceFolder>>actualTask.scope;
        return !!workspaceFolder.uri && (isPathEqual(workspaceFolder.uri.fsPath, expectedPath) || isSubpath(workspaceFolder.uri.fsPath, expectedPath));
    } else {
        return false;
    }
}

function isScopeEqual(task: vscode.Task, workspaceFsPath: string): boolean {
    if (typeof task.scope === 'object') {
        const workspaceFolder: Partial<vscode.WorkspaceFolder> = task.scope;
        return !!workspaceFolder.uri && (isPathEqual(workspaceFolder.uri.fsPath, workspaceFsPath) || isSubpath(workspaceFolder.uri.fsPath, workspaceFsPath));
    } else {
        return false;
    }
}

async function waitForPreDeployTask(preDeployTask: vscode.Task, deployFsPath: string): Promise<IPreDeployTaskResult> {
    return await new Promise((resolve: (preDeployTaskResult: IPreDeployTaskResult) => void): void => {
        const errorListener: vscode.Disposable = vscode.tasks.onDidEndTaskProcess((e: vscode.TaskProcessEndEvent) => {
            if (isScopeEqual(e.execution.task, deployFsPath) && e.exitCode !== 0) {
                // Throw if _any_ task fails since preDeployTasks can depend on other tasks)
                errorListener.dispose();
                resolve({ taskName: e.execution.task.name, exitCode: e.exitCode, failedToFindTask: false });
            }

            // this is the actual preDeployTask that we are waiting on
            if (e.execution.task === preDeployTask) {
                errorListener.dispose();
                resolve({ taskName: e.execution.task.name, exitCode: e.exitCode, failedToFindTask: false });
            }
        });
    });
}

export async function handleFailedPreDeployTask(context: IActionContext, preDeployResult: IPreDeployTaskResult): Promise<void> {
    const message: string = localize('taskFailed', 'Errors exist after running preDeployTask "{0}". See task output for more info.', preDeployResult.taskName);
    const deployAnyway: vscode.MessageItem = { title: localize('deployAnyway', 'Deploy Anyway') };
    const openSettings: vscode.MessageItem = { title: localize('openSettings', 'Open Settings') };
    const result: vscode.MessageItem | undefined = await vscode.window.showErrorMessage(message, { modal: true }, deployAnyway, openSettings);
    if (result === deployAnyway) {
        context.telemetry.properties.preDeployTaskResponse = 'deployAnyway';
    } else if (result === openSettings) {
        context.telemetry.properties.preDeployTaskResponse = 'openSettings';
        await vscode.commands.executeCommand('workbench.action.openSettings');
        throw new UserCancelledError();
    } else {
        context.telemetry.properties.preDeployTaskResponse = 'cancel';
        throw new UserCancelledError();
    }
}
