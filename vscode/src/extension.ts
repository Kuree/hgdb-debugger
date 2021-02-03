'use strict';

import * as vscode from 'vscode';
import {WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken} from 'vscode';
import {HGDBDebugSession} from './hgdbDebug';
import * as Net from 'net';


export function activate(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.commands.registerCommand('extension.hgdb-debug.getProgramName', config => {
        return vscode.window.showInputBox({
            placeHolder: "Please enter the name of a debug database file in the workspace folder",
            value: "debug.db"
        });
    }));

    // register a configuration provider for 'hgdb' debug type
    const provider = new HGDBConfigurationProvider();
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('hgdb', provider));

    // The following use of a DebugAdapter factory shows how to run the debug adapter inside the extension host (and not as a separate process).
    const factory = new HGDBDebugAdapterDescriptorFactory();
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('hgdb', factory));
    context.subscriptions.push(factory);

}

export function deactivate() {
    // nothing to do
}


class HGDBConfigurationProvider implements vscode.DebugConfigurationProvider {

    /**
     * Massage a debug configuration just before a debug session is being launched,
     * e.g. add all missing attributes to the debug configuration.
     */
    async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): Promise<ProviderResult<DebugConfiguration>> {

        // if launch.json is missing or empty or missing entries
        if (!config.type) {
            config.type = 'hgdb';
        }
        if (!config.name) {
            config.name = 'Launch';
        }
        if (!config.request) {
            config.request = 'launch';
        }
        if (!config.runtimeIP) {
            config.runtimeIP = "0.0.0.0";
        }
        if (!config.runtimePort) {
            config.runtimePort = 8888;
        }
        if (!config.stopOnEntry) {
            config.stopOnEntry = true;
        }
        if (!config.dstPath) {
            config.dstPath = "";
        }
        if (!config.srcPath) {
            config.srcPath = "";
        }

        if (!config.program) {
            // try to get it again
            await vscode.window.showInputBox({
                placeHolder: "Debug database filename",
                prompt: "Debug database filename",
                value: "debug.db"
            }).then((value) => {
                if (value !== undefined) {
                    config.program = value;
                }
            });
            if (!config.program) {
                vscode.window.showErrorMessage("Program name cannot be empty!");
                return undefined;
            }
            await vscode.window.showInputBox({
                placeHolder: "HGDB runtime port number",
                value: "8888",
                prompt: "HGDB runtime port number"
            }).then((value) => {
                if (value !== undefined) {
                    if (HGDBConfigurationProvider.isNormalInteger(value)) {
                        config.runtimePort = Number(value);
                    } else {
                        vscode.window.showWarningMessage(`${value} is not a valid port number. Using default instead`);
                    }
                }
            });

        }

        return config;
    }

    private static isNormalInteger(str: string) {
        const n = Math.floor(Number(str));
        return n !== Infinity && String(n) === str && n >= 0;
    }
}

class HGDBDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

    private server?: Net.Server;
    public session: HGDBDebugSession;

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

        if (!this.server) {
            // start listening on a random port
            this.server = Net.createServer(socket => {
                const session = new HGDBDebugSession();
                this.session = session;
                session.setRunAsServer(true);
                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // make VS Code connect to debug server
        return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
    }

    dispose() {
        if (this.server) {
            this.server.close();
        }
    }
}
