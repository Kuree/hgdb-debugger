import {EventEmitter} from 'events';
import * as path from 'path';
import * as ws from 'websocket';
import * as util from './util';


export interface HGDBBreakpoint {
    id: number;
    line_num: number;
    filename: string;
    valid: boolean;
    column_num: number;
}


export class HGDBRuntime extends EventEmitter {

    // maps from id to the actual breakpoint
    private _breakPoints = new Map<number, HGDBBreakpoint>();

    private _currentLocalVariables = new Map<number, Array<Map<string, string>>>();
    private _currentGeneratorNames = new Map<number, string>();
    private _currentBreakpointIDs = new Map<number, number>();
    private _currentGeneratorVariables = new Map<number, Array<Map<string, string>>>();
    private _currentBreakpointTypes = new Map<number, string>();
    private _currentTime = 0;

    // need to pull this from configuration
    private _runtimeIP = "0.0.0.0";
    private _runtimePort = 8888;
    private _connected = false;
    // websocket client
    private _ws: ws.client = new ws.client();
    private _connection: ws.connection | undefined;

    private _currentFilename: string = "";
    private _currentLineNum: number = 1;
    private _currentColNum: number | undefined;

    private readonly _workspaceDir: string;

    private _srcPath: string = "";
    private _dstPath: string = "";

    // scope for repl
    private _currentScope: number = 0;

    // token id
    private _tokenCount: number = 0;
    // token based callback
    private _tokenCallbacks = new Map<string, Function>();

    // pending requests. this is basically a queue of requests
    // needed to send before the debug server is connected
    private _queuedPayload = new Array<object>();


    public currentFilename() {
        return this._currentFilename;
    }

    public currentLineNum() {
        return this._currentLineNum;
    }

    public currentColNum() {
        return this._currentColNum;
    }

    public getCurrentLocalVariables() {
        return this._currentLocalVariables;
    }

    public getCurrentGeneratorVariables() {
        return this._currentGeneratorVariables;
    }

    public getCurrentGeneratorNames() {
        return this._currentGeneratorNames;
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

    constructor(workspace_dir: string) {
        super();
        this._workspaceDir = workspace_dir;
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string) {
        // setting up the
        this._ws.on("connectFailed", (error) => {
            this.sendEvent("errorMessage", `Unable to connect to simulator using port ${this._runtimePort}: ${error}`);
        });

        let promise = new Promise<void>((resolve, reject) => {
            this._ws.on("connect", async (connection) => {
                // we have successfully connected to the runtime server

                this._connection = connection;
                // need to add more handles
                this.setConnection(connection);

                // reject the promise if something wrong happens
                this.on("errorMessage", () => {
                    reject();
                });

                await this.connectRuntime(program);

                // if there is any queued payload, this is the time to send out
                for (let i = 0; i < this._queuedPayload.length; i++) {
                    await this.sendPayload(this._queuedPayload[i]);
                }
                this._queuedPayload.length = 0;

                // let the debugger know that we have properly connected and enter interactive mode
                this.sendEvent('stopOnEntry');
                resolve();
            });
        });

        // connect to specified port
        await this._ws.connect(`ws://${this._runtimeIP}:${this._runtimePort}`);
        await promise;
    }

    private setConnection(connection: ws.connection) {
        let callback = (message) => {
            // handle different responses
            const str_data = message.utf8Data;
            if (!str_data) {
                return;
            }
            const resp = JSON.parse(str_data);
            const status = resp.status;
            if (status !== "success") {
                this.sendEvent("errorMessage", resp.payload.reason);
            }

            // switch between different response types
            const resp_type = resp.type;
            switch (resp_type) {
                case "breakpoint": {
                    // breakpoint response is server initialized
                    this.onBreakpoint(resp.payload);
                    break;
                }
                default:
                    // we use token based req-resp here
                    // each response will have a unique token matching with the request
                    // so we don't need to check response type at all
                    const token = resp.token;
                    if (token) {
                        const cb = this._tokenCallbacks.get(token);
                        if (cb) {
                            cb(resp);
                            this._tokenCallbacks.delete(token);
                        }
                    }
            }
        };
        // without the bind it will not work. glorious ts/js
        connection.on("message", callback.bind(this));

        // if server closes first
        let close_cb = () => {
            this.sendEvent('end');
        };
        connection.on("close", close_cb.bind(this));
    }

    public async stop() {
        await this.sendCommand("stop");
        this._connected = false;
        await this._connection?.close();
    }

    private addFrameInfo(payload: Object) {
        this._currentFilename = payload["filename"];
        this._currentLineNum = Number.parseInt(payload["line_num"]);
        const col = Number.parseInt(payload["col_num"]);
        if (col !== undefined && col > 0) {
            this._currentColNum = col;
        } else {
            this._currentColNum = undefined;
        }

        const instances: Array<any> = payload["instances"];
        for (let i = 0; i < instances.length; i++) {
            const entry = instances[i];
            const local: Object = entry["local"];
            const generator: Object = entry["generator"];
            const instance_id_ = entry["instance_id"];
            const instance_name = entry["instance_name"];
            const breakpoint_id_ = entry["breakpoint_id"];
            const namespace_id = entry["namespace_id"];

            const instance_id = this.get_id_ns_to(instance_id_, namespace_id);
            const breakpoint_id = this.get_id_ns_to(breakpoint_id_, namespace_id);

            // convert them into the format and store them
            const local_variables_raw = new Map<string, string>(Object.entries(local));
            const local_variables = util.convertToDotMap(local_variables_raw);
            // merge this two
            // notice this is used for having multiple instances values shown in the
            // debug window
            const vars = this._currentLocalVariables.get(instance_id);
            if (vars) {
                vars.push(local_variables);
            } else {
                this._currentLocalVariables.set(instance_id, [local_variables]);
            }
            const gen_vars = this._currentGeneratorVariables.get(instance_id);
            const new_gen_var_raw = new Map<string, string>(Object.entries(generator));
            const new_gen_var = util.convertToDotMap(new_gen_var_raw);
            if (gen_vars) {
                gen_vars.push(new_gen_var);
            } else {
                this._currentGeneratorVariables.set(instance_id, [new_gen_var]);
            }
            // get instance name
            this._currentGeneratorNames.set(instance_id, instance_name);
            // set up the mapping between instance name and breakpoint id
            // used for REPL
            this._currentBreakpointIDs.set(instance_id, breakpoint_id);
            // set the breakpoint type
            const bp_type = entry["bp_type"];
            this._currentBreakpointTypes.set(instance_id, bp_type);
        }

        // set time
        this._currentTime = payload["time"];
    }

    /**
     * Continue execution to the end/beginning.
     */
    public async continue() {
        await this.run(false);
    }

    /**
     * Step to the next/previous non empty line.
     */
    public async step() {
        await this.run(true);
    }

    public async stepBack() {
        if (this._connected) {
            await this.sendCommand("step_back");
        } else {
            // inform user that it's not connected to the simulator runtime?
        }
    }

    /*
     * Verify breakpoint in file with given line.
     */
    public async verifyBreakpoint(filename: string, line: number, column?: number) {
        // get the absolute path
        filename = path.resolve(filename);
        let bps = new Array<HGDBBreakpoint>();

        if (!column) {
            column = 0;
        }

        let get_breakpoints = new Promise<void>((resolve, reject) => {
            const token = this.getToken();
            // register a callback
            this.addCallback(token, (resp) => {
                const status = resp.status;
                if (status === "error") {
                    this.sendEvent("errorMessage", `Cannot set breakpoint at ${filename}:${line}`);
                    reject();
                } else {
                    const bps_data = resp.payload;
                    bps_data.forEach(e => {
                        let bp = <HGDBBreakpoint>{
                            valid: true,
                            line_num: e.line_num,
                            id: e.id,
                            filename: filename,
                            column_num: e.column_num
                        };
                        let id = bp.id;
                        this.sendEvent('breakpointValidated', bp);
                        this._breakPoints.set(id, bp);
                        bps.push(bp);
                    });
                    resolve();
                }
            });
            this.sendBpLocation(filename, line, token, column);
        });

        await get_breakpoints;

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

    public async getBreakpoints(filename: string, line: number) {
        const token = this.getToken();
        let promise = new Promise<Array<number>>((resolve) => {
            this.addCallback(token, (resp) => {
                const status = resp.status;
                if (status === "error") {
                    resolve([]);
                } else {
                    const bps = resp.payload;
                    let cols = new Array<number>();
                    bps.forEach(bp => {
                        cols.push(bp.column_num);
                    });
                    resolve(cols);
                }
            });
        });
        await this.sendBpLocation(filename, line, token);
        return await promise;
    }

    public async clearDataBreakpoints() {
        const token = this.getToken();
        return new Promise<void>((resolve, reject) => {
            this.addCallback(token, (resp) => {
                if (resp.status === "success") {
                    resolve();
                } else {
                    reject();
                }
            });
            const payload = {
                "request": true, "type": "data-breakpoint", "token": token,
                "payload": {
                    "action": "clear"
                }
            };
            this.sendPayload(payload);
        });
    }

    public async validateDataBreakpoint(instanceID: number, var_name: string) {
        const bp_id = this._currentBreakpointIDs.get(instanceID);
        if (!bp_id) {
            return new Promise<boolean>(() => {
                return false;
            });
        } else {
            const token = this.getToken();
            return new Promise<boolean>((resolve) => {
                this.addCallback(token, (resp) => {
                    resolve(resp.status === "success");
                });
                const payload = {
                    "request": true, "type": "data-breakpoint", "token": token,
                    "payload": {
                        "var_name": var_name,
                        "breakpoint-id": bp_id,
                        "action": "info"
                    }
                };
                this.sendPayload(payload);
            });
        }
    }

    public async addDataBreakPoint(instanceID: number, var_name: string, cond: string) {
        const bp_id = this._currentBreakpointIDs.get(instanceID);
        if (!bp_id) {
            return new Promise<boolean>(() => {
                return false;
            });
        } else {
            const token = this.getToken();
            return new Promise<boolean>((resolve) => {
                this.addCallback(token, (resp) => {
                    resolve(resp.status === "success");
                });
                const payload = {
                    "request": true, "type": "data-breakpoint", "token": token,
                    "payload": {
                        "var_name": var_name,
                        "breakpoint-id": bp_id,
                        "condition": cond,
                        "action": "add"
                    }
                };
                this.sendPayload(payload);
            });
        }
    }

    public static getFrameID(instance_id: number, stack_index: number): number {
        // notice that we need to store instance id and stack index into a single
        // number
        // since in JS the number is 2^53, according to
        // https://stackoverflow.com/a/4375743
        // we store the lower 13 bits as stack index and the reset high bits
        // as instance_id. this should give us enough space for all millions of
        // instances and different stack frames
        return instance_id << 13 | stack_index;
    }

    public static getInstanceFrameID(frame_id: number): [number, number] {
        const instance_id = frame_id >> 13;
        const stack_index = frame_id & ((1 << 13) - 1);
        return [instance_id, stack_index];
    }

    public async getGlobalVariables() {
        // only time so far
        return [{
            name: "Time",
            value: this._currentTime.toString()
        }];
    }

    public stack(instance_id: number) {
        // we only have one stack frame
        const frames: Array<any> = [];
        const frames_infos = this._currentLocalVariables.get(instance_id);
        if (!frames_infos) {
            // empty stack
            return {
                frames: frames,
                count: 0
            };
        } else {
            const num_frames = frames_infos.length;
            const filename = this.currentFilename();
            const line_num = this.currentLineNum();
            const col_num = this.currentColNum();
            for (let i = 0; i < num_frames; i++) {
                let name = this._currentGeneratorNames.get(instance_id);
                if (!name) {
                    name = `Instance ID ${instance_id}`;
                }
                frames.push({
                    index: HGDBRuntime.getFrameID(instance_id, i),
                    name: `[${instance_id}]: ${name}`,
                    file: filename,
                    line: line_num,
                    col: col_num
                });
            }
            return {
                frames: frames,
                count: num_frames
            };
        }
    }

    public async setBreakpoint(breakpoint_id: number, expr?: string) {
        const token = this.getToken();
        const payload = {
            "request": true,
            "type": "breakpoint-id",
            "token": token,
            "payload": {"id": breakpoint_id, "action": "add"}
        };
        if (expr) {
            payload["payload"]["condition"] = expr;
        }
        let promise = new Promise<void>((resolve, reject) => {
            this.addCallback(token, (resp) => {
                if (resp.status === "error") {
                    reject();
                } else {
                    resolve();
                }
            });
        });
        await this.sendPayload(payload);
        return promise;
    }

    public async getSimulatorStatus(info_command: string = "breakpoints") {
        // used for debugging only. not actually used by the debug adapter
        const token = this.getToken();
        const payload = {
            "request": true,
            "type": "debugger-info",
            "token": token,
            "payload": {"command": info_command}
        };
        let promise = new Promise<any>((resolve, reject) => {
            this.addCallback(token, (resp) => {
                if (resp.status === "error") {
                    reject();
                } else {
                    resolve(resp.payload);
                }
            });
        });
        await this.sendPayload(payload);
        return promise;
    }

    public async handleREPL(expression: string, scope?: number) {
        const tokens = expression.split(" ");
        if (tokens[0] === "scope") {
            if (tokens.length !== 2) {
                return "Invalid set-scope command: " + expression;
            }
            let p = parseInt(tokens[1]);
            if (p) {
                this._currentScope = p;
            }
            this._currentScope = parseInt(tokens[1]);
            return "";
        } else if (tokens[0] === "clear") {
            this._currentScope = 0;
            return "";
        } else {
            // ask the server about the values
            // we only allow evaluation inside the scope of an instance, not the current breakpoint
            // since we can have multiple frames at the same, and VS code won't notify us which one
            // is active
            return await this.sendEvaluation(scope ? scope : this._currentScope, expression);
        }
    }

    public async evaluateInstanceScope(expression: string, instance_id: number) {
        return await this.sendEvaluation(instance_id, expression);
    }

    public async setValue(var_name: string, value: number, id: number, is_local: boolean) {
        const token = this.getToken();
        const payload = {
            "request": true,
            "type": "set-value",
            "token": token,
            "payload": {"var_name": var_name, "value": value}
        };
        if (is_local) {
            const breakpoint_id = this._currentBreakpointIDs.get(id);
            if (breakpoint_id) {
                const [b_id, ns_id] = this.get_id_ns_from(breakpoint_id);
                payload["payload"]["breakpoint_id"] = b_id;
                payload["payload"]["namespace_id"] = ns_id;
            }
        } else {
            const [inst_id, ns_id] = this.get_id_ns_from(id);
            payload["payload"]["instance_id"] = inst_id;
            payload["payload"]["namespace_id"] = ns_id;
        }

        let promise = new Promise<boolean>((resolve, reject) => {
            this.addCallback(token, (resp) => {
                if (resp.status === "error") {
                    reject(false);
                } else {
                    resolve(true);
                }
            });
        });
        await this.sendPayload(payload);
        return promise;
    }

    public async reverseContinue(on_error?) {
        await this.sendCommand("reverse_continue", on_error);
    }

    // private methods
    private async sendPayload(payload: any) {
        const payload_str = JSON.stringify(payload);
        if (this._connection) {
            await this._connection.send(payload_str);
        } else {
            // put it in the queue
            this._queuedPayload.push(payload);
        }
    }

    private async sendCommand(command: string, on_error?) {
        const token = this.getToken();
        const payload = {"request": true, "type": "command", "token": token, "payload": {"command": command}};
        return new Promise<void>((async (resolve, reject) => {
            this.addCallback(token, async (resp) => {
                if (resp.status === "error") {
                    if (on_error) {
                        on_error();
                    }
                    reject();
                } else {
                    resolve();
                }
            });

            await this.sendPayload(payload);
        }));

    }

    private async sendEvaluation(breakpoint_id: number, expression: string) {
        const token = this.getToken();
        const payload = {
            "request": true,
            "type": "evaluation",
            "token": token,
            "payload": {"breakpoint_id": breakpoint_id, "expression": expression}
        };

        return new Promise<string>((async (resolve) => {
            this.addCallback(token, async (resp) => {
                if (resp.status === "error") {
                    const reason = resp.payload.reason;
                    resolve(reason);
                } else {
                    resolve(resp.payload.result);
                }
            });
            await this.sendPayload(payload);
        }));
    }

    private async run(is_step: Boolean) {
        if (this._connected) {
            if (!is_step) {
                await this.sendCommand("continue");
            } else {
                await this.sendCommand("step_over");
            }
        } else {
            // inform user that it's not connected to the simulator runtime?
        }
    }

    private async sendRemoveBreakpoints(filename: string) {
        const token = this.getToken();
        return new Promise<void>((resolve, reject) => {
            this.addCallback(token, (resp) => {
                if (resp.status === "success") {
                    resolve();
                } else {
                    reject();
                }
            });
            const payload = {
                "request": true, "type": "breakpoint", "token": token,
                "payload": {
                    "filename": filename,
                    "action": "remove"
                }
            };
            this.sendPayload(payload);
        });
    }

    private async connectRuntime(file: string) {
        // resolve it to make it absolute path
        if (!path.isAbsolute(file)) {
            file = path.join(this._workspaceDir, file);
        }

        // register callback
        const token = this.getToken();
        let promise = new Promise<void>((resolve, reject) => {
            this.addCallback(token, async (resp) => {
                if (resp.status === "error") {
                    const reason = resp.payload.reason;
                    this.sendEvent("errorMessage", `Failed to connect to a running simulator. Reason: ${reason}`);
                    await this.stop();
                    reject();
                } else {
                    this._connected = true;
                    this.sendEvent("simulatorConnected");
                    resolve();
                }
            });
        });

        await this.sendConnectMessage(file, token);
        return promise;
    }

    private onBreakpoint(payload, is_exception = false) {
        this._currentLocalVariables.clear();
        this._currentGeneratorVariables.clear();
        this._currentGeneratorNames.clear();
        this._currentBreakpointIDs.clear();
        this._currentBreakpointTypes.clear();
        // we will get a list of values
        this.addFrameInfo(payload);
        // recreate threads
        if (!is_exception) {
            this.fireEventsForBreakPoint();
        } else {
            this.fireEventsForException();
        }
    }

    /**
     * Get a random token via UUID
     */
    private getToken(): string {
        const id = this._tokenCount++;
        // all our tokens has vscode prefix
        // this is to avoid conflicts from other connected devices
        return "vscode-" + id.toString();
    }

    private addCallback(token: string, callback: Function) {
        this._tokenCallbacks.set(token, callback);
    }

    private async sendConnectMessage(db_filename: string, token: string) {
        let payload = {
            "request": true, "type": "connection", "payload": {
                "db_filename": db_filename,
            },
            "token": token
        };
        if (this._srcPath.length > 0 && this._dstPath.length > 0) {
            // add path mapping as well
            payload["payload"]["path_mapping"] = {};
            payload["payload"]["path_mapping"][this._srcPath] = this._dstPath;
        }
        await this.sendPayload(payload);
    }

    private async sendBpLocation(filename: string, line_num: number, token: string, column_num?: number) {
        const payload = {
            "request": true, "type": "bp-location", "token": token,
            "payload": {"filename": filename, "line_num": line_num}
        };
        if (column_num) {
            payload["payload"]["column_num"] = column_num;
        }
        await this.sendPayload(payload);
    }

    /**
     * Fire events if the simulator hits a breakpoint
     */
    private fireEventsForBreakPoint() {
        // depends on if we hit a data breakpoint or not
        let hasData = false;
        this._currentBreakpointTypes.forEach((t) => {
            if (t === "data") {
                hasData = true;
            }
        });
        if (hasData) {
            this.sendEvent("stopOnDataBreakpoint");
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

    /**
     * handles breakpoint id and its native representation
     */
    private get_id_ns_from(id: number): [number, number] {
        // we use the fact that JS number is 53 bit. we just shift the ns to 32
        let i = Number(Number(id) & Number(0xFFFFFFFF));
        let ns_id = Number(Number(id) >> Number(32));
        return [i, ns_id];
    }

    private get_id_ns_to(id: number, ns_id: number) : number {
        let res_ns_id = Number(ns_id) << Number(32);
        return Number(id) | res_ns_id;
    }
}
