import * as ip from 'internal-ip';
import * as vscode from 'vscode';

export async function get_ip() : Promise<string> {
    return ip.v4();
}

export class ContextKey {
    private _name: string;
    private _lastValue: boolean;

    constructor(name: string) {
        this._name = name;
        this._lastValue = false;
    }

    public set(value: boolean): void {
        if (this._lastValue === value) {
            return;
        }
        this._lastValue = value;
        vscode.commands.executeCommand('setContext', this._name, this._lastValue);
    }
}
