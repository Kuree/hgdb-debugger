import {EventEmitter} from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import * as utils from './utils';
import * as ws from 'websocket';


export interface HGDBBreakpoint {
    id: number;
    line: number;
    filename: string;
    valid: boolean;
    column: number;
}


export class HGDBRuntime extends EventEmitter {

    // maps from id to the actual breakpoint
    private _breakPoints = new Map<number, HGDBBreakpoint>();

    private _current_breakpoint_instance_id = 0;
    private _current_local_variables = new Map<number, Array<Map<string, string>>>();
    private _current_generator_names = new Map<number, string>();
    private _current_generator_variables = new Map<number, Array<Map<string, string>>>();

    // need to pull this from configuration
    private _runtimeIP = "0.0.0.0";
    private _runtimePort = 8888;
    private _connected = false;
    // websocket client
    private _ws: ws.client = new ws.client();
    private _connection: ws.connection | undefined;

    private _current_filename: string;
    private _current_line_num: number;

    private _srcPath: string = "";
    private _dstPath: string = "";

    // token id
    private _token_count: number = 0;
    // token based callback
    private _token_callbacks = new Map<string, Function>();


    public current_filename() {
        return this._current_filename;
    }

    public current_num() {
        return this._current_line_num;
    }

    public getCurrentLocalVariables() {
        return this._current_local_variables;
    }

    public getCurrentGeneratorVariables() {
        return this._current_generator_variables;
    }

    public getCurrentGeneratorNames() {
        return this._current_generator_names;
    }

    public getCurrentBreakpointInstanceId() {
        return this._current_breakpoint_instance_id;
    }

    public setRuntimeIP(ip: string) {
        this._runtimeIP = ip;
    }

    public setRuntimePort(port: number) {
        this._runtimePort = port;
    }

    public setSrcPath(path: string) {
        this._srcPath = path;
    }

    public setDstPath(path: string) {
        this._dstPath = path;
    }

    constructor() {
        super();
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string) {
        // setting up the
        this._ws.on("connectFailed", (error) => {
            vscode.window.showErrorMessage(`Unable to connect to simulator using port ${this._runtimePort}`);
        });

        this._ws.on("connect", (connection) => {
            // we have successfully connected to the runtime server

            this._connection = connection;
            this._connected = true;
            // need to add more handles
            connection.on("message", (message) => {
                // handle different responses
                const str_data = message.utf8Data;
                if (!str_data) {
                    return;
                }
                const resp = JSON.parse(str_data);

                // switch between different response types
                const resp_type = resp.type;
                switch (resp_type) {
                    case "breakpoint": {
                        // breakpoint response is server initialized
                        this.on_breakpoint(resp.payload);
                        break;
                    }
                    default:
                        // we use token based req-resp here
                        // each response will have a unique token matching with the request
                        // so we don't need to check response type at all
                        const token = resp.token;
                        if (token) {
                            const callback = this._token_callbacks[token];
                            callback(resp.status, resp.payload);
                            this._token_callbacks.delete(token);
                        }
                }
            });

            // if server closes first
            connection.on("close", () => {
                this.sendEvent('end');
            });

            // actually need to send a connection message to the debug server
            this.send_connect_message(program);

            // let the debugger know that we have properly connected and enter interactive mode
            this.sendEvent('stopOnEntry');
        });

        // connect to specified port
        this._ws.connect(`ws://${this._runtimeIP}:${this._runtimePort}`);
    }

    public async stop() {
        this.send_command("stop");
    }

    private add_frame_info(payload: Object) {
        const local: Object = payload["local"];
        const generator: Object = payload["generator"];
        const id = Number.parseInt(payload["id"]);
        const instance_id = Number.parseInt(payload["instance_id"]);
        this._current_filename = payload["filename"];
        this._current_line_num = Number.parseInt(payload["line_num"]);
        this._current_breakpoint_instance_id = instance_id;
        // convert them into the format and store them
        const local_variables = new Map<string, string>(Object.entries(local));
        // merge this two
        const vars = this._current_local_variables.get(instance_id);
        const new_var = new Map<string, string>([...local_variables]);
        if (vars) {
            vars.push(new_var);
        } else {
            this._current_local_variables.set(instance_id, [new_var]);
        }
        const gen_vars = this._current_generator_variables.get(instance_id);
        const new_gen_var = new Map<string, string>(Object.entries(generator));
        if (gen_vars) {
            gen_vars.push(new_gen_var);
        } else {
            this._current_generator_variables.set(instance_id, [new_gen_var]);
        }
        // get instance name
        const instance_name = payload["instance_name"];
        generator["instance_name"] = instance_name;
        this._current_generator_names.set(instance_id, instance_name);
        return id;
    }

    /**
     * Continue execution to the end/beginning.
     */
    public continue() {
        this.run(false);
    }

    /**
     * Step to the next/previous non empty line.
     */
    public step() {
        this.run(true);
    }

    /*
     * Verify breakpoint in file with given line.
     */
    public verifyBreakpoint(filename: string, line: number, column?: number, expr?: string) {
        // get the absolute path
        filename = path.resolve(filename);
        let bps = new Array<HGDBBreakpoint>();

        if (!column) {
            column = 0;
        }
        if (!expr) {
            expr = "";
        }

        let block_get = (u: string) => {
            return new Promise((resolve, reject) => {
                request.get(u, (_, res, body) => {
                    if (res.statusCode === 200) {
                        let bps_data = JSON.parse(body);
                        bps_data.forEach(e => {
                            let bp = <HGDBBreakpoint>{valid: true, line, id: e.id, filename: filename, column: e.col};
                            let id = bp.id;
                            this.sendEvent('breakpointValidated', bp);
                            this._breakPoints.set(id, bp);
                            bps.push(bp);
                        });
                        resolve();
                    } else {
                        vscode.window.showErrorMessage(`Cannot set breakpoint at ${filename}:${line}`);
                        reject();
                    }
                });
            });
        };

        let url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint/${filename}:${line}:${column}`;
        await block_get(url);

        return bps;
    }

    /*
     * Clear all breakpoints for file.
     */
    public async clearBreakpoints(filename: string) {
        // find the filename
        const resolved_filename = path.resolve(filename);
        await this.sendRemoveBreakpoints(resolved_filename);
    }

    public getBreakpoints(filename: string, line: number, fn: (id: Array<number>) => void) {
        var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint/${filename}:${line}`;
        request.get(url, (_, res, body) => {
            if (res.statusCode === 200) {
                const bps = JSON.parse(body);
                let cols = new Array<number>();
                bps.forEach(bp => {
                    cols.push(bp.col);
                });
                fn(cols);
            }
        });
    }

    public static get_frame_id(instance_id: number, stack_index: number): number {
        // notice that we need to store instance id and stack index into a single
        // number
        // since in JS the number is 2^53, according to
        // https://stackoverflow.com/a/4375743
        // we store the lower 13 bits as stack index and the reset high bits
        // as instance_id. this should give us enough space for all millions of
        // instances and different stack frames
        return instance_id << 13 | stack_index;
    }

    public static get_instance_frame_id(frame_id: number): [number, number] {
        const instance_id = frame_id >> 13;
        const stack_index = frame_id & ((1 << 13) - 1);
        return [instance_id, stack_index];
    }

    public async getGlobalVariables() {
        return [];
    }

    public stack(instance_id: number) {
        // we only have one stack frame
        const frames: Array<any> = [];
        const frames_infos = this._current_local_variables.get(instance_id);
        if (!frames_infos) {
            // empty stack
            return {
                frames: frames,
                count: 0
            };
        } else {
            const num_frames = frames_infos.length;
            const filename = this.current_filename();
            const line_num = this.current_num();
            for (let i = 0; i < num_frames; i++) {
                frames.push({
                    index: HGDBRuntime.get_frame_id(instance_id, i),
                    name: `Scope ${i}`,
                    file: filename,
                    line: line_num
                });
            }
            return {
                frames: frames,
                count: num_frames
            };
        }

    }

    public sendBreakpoint(breakpoint_id: number, expr?: string) {
        let url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
        let payload = {id: breakpoint_id, expr: expr || ""};
        let options = {
            method: "post",
            body: payload,
            json: true,
            url: url
        };
        request(options);
        if (this._connection) {
            const payload = {
                "request": true, "type": "breakpoint-id", "token": token,
                "payload": {"id": bp_id, "action": "add"}
            }
        }
    }

    // private methods
    private send_payload(payload: any) {
        const payload_str = JSON.stringify(payload);
        if (this._connection) {
            this._connection.send(payload_str);
        }
    }

    private send_command(command: string) {
        const payload = {"request": true, "type": "command", "payload": {"command": command}};
        this.send_payload(payload);
    }

    private run(is_step: Boolean) {
        if (this._connected) {
            if (!is_step) {
                this.send_command("continue");
            } else {
                this.send_command("step-over");
            }
        } else {
            // inform user that it's not connected to the simulator runtime?
        }
    }

    private async sendRemoveBreakpoints(filename: string) {
        var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint/file/${filename}`;
        return new Promise<void>((resolve, _) => {
            request.delete(url, () => {
                resolve();
            });
        });
    }

    private async connectRuntime(file: string) {
        // resolve it to make it absolute path
        if (file.charAt(0) !== '/') {
            // using workplace folder
            let work_dirs = vscode.workspace.workspaceFolders;
            if (work_dirs) {
                if (work_dirs.length > 1) {
                    // too many workspace and unable to resolve
                    return vscode.window.showErrorMessage(`Too many workspace opened. Unable to resolve ${file}`);
                }
                file = path.join(work_dirs[0].uri.path, file);
            }
        }

        const ip = await utils.get_ip();
        var payload = {ip: ip, port: this._debuggerPort, database: file};
        if (this._srcPath !== "" && this._dstPath !== "") {
            payload["src_path"] = this._srcPath;
            payload["dst_path"] = this._dstPath;
        }
        var url = `http://${this._runtimeIP}:${this._runtimePort}/connect`;
        var options = {
            method: "post",
            body: payload,
            json: true,
            url: url
        };
        request(options, (_, res, __) => {
            if (!res || res.statusCode !== 200) {
                vscode.window.showErrorMessage("Failed to connect to a running simulator");
            } else {
                this._connected = true;
                // request all the files and open them
                request.get(`http://${this._runtimeIP}:${this._runtimePort}/files`, (_, __, body) => {
                    body = JSON.parse(body);
                    var opened_dirs = new Set<string>();
                    body.forEach((file: string) => {
                        // do a translation if possible
                        // notice that dst path is the one that's being used by server and
                        // src path is the one used by the user
                        if (file.indexOf(this._dstPath) >= 0) {
                            file = file.replace(this._dstPath, this._srcPath);
                        }
                        // need to open the workspace
                        var base_dir = path.dirname(file);
                        if (!opened_dirs.has(base_dir)) {
                            vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ?
                                vscode.workspace.workspaceFolders.length : 0, null, {uri: vscode.Uri.file(base_dir)});
                            opened_dirs.add(base_dir);
                        }
                        var res = vscode.workspace.openTextDocument(vscode.Uri.file(file));
                        if (!res) {
                            return vscode.window.showInformationMessage("Unable to open document");
                        }
                    });
                });
            }
        });
    }

    private on_breakpoint(payload, is_exception = false) {
        this._current_local_variables.clear();
        this._current_generator_variables.clear();
        this._current_generator_names.clear();
        // we will get a list of values
        const id = this.add_frame_info(payload);
        // recreate threads
        if (!is_exception) {
            this.fireEventsForBreakPoint(id);
        } else {
            this.fireEventsForException();
        }
    }

    /**
     * Get a random token via UUID
     */
    private get_token(): string {
        const id = this._token_count++;
        return id.toString();
    }

    private send_connect_message(db_filename: string) {
        const payload = {
            "request": true, "type": "connection", "payload": {
                "db_filename": db_filename,
            },
            "token": this.get_token()
        };
        this.send_payload(payload);
    }

    /**
     * Fire events if the simulator hits a breakpoint
     */
    private fireEventsForBreakPoint(breakpointID: number) {
        var bp = this._breakPoints.get(breakpointID);
        if (bp) {
            this.sendEvent("stopOnBreakpoint");
        } else {
            this.sendEvent("stopOnBreakpoint");
        }
    }

    private fireEventsForException() {
        this.sendEvent("stopOnException");
    }

    private sendEvent(event: string, ...args: any[]) {
        setImmediate(_ => {
            this.emit(event, ...args);
        });
    }
}
