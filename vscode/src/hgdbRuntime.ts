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

    private _current_local_variables = new Map<number, Array<Map<string, string>>>();
    private _current_generator_names = new Map<number, string>();
    private _current_generator_variables = new Map<number, Array<Map<string, string>>>();
    private _current_time = 0;

    // need to pull this from configuration
    private _runtimeIP = "0.0.0.0";
    private _runtimePort = 8888;
    private _connected = false;
    // websocket client
    private _ws: ws.client = new ws.client();
    private _connection: ws.connection | undefined;

    private _current_filename: string;
    private _current_line_num: number;

    private readonly _workspace_dir: string;

    // private _srcPath: string = "";
    // private _dstPath: string = "";

    // token id
    private _token_count: number = 0;
    // token based callback
    private _token_callbacks = new Map<string, Function>();

    // pending requests. this is basically a queue of requests
    // needed to send before the debug server is connected
    private _queued_payload = new Array<object>();


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

    public setRuntimeIP(ip: string) {
        this._runtimeIP = ip;
    }

    public setRuntimePort(port: number) {
        this._runtimePort = port;
    }

    public setSrcPath(path: string) {
        // this._srcPath = path;
    }

    public setDstPath(path: string) {
        // this._dstPath = path;
    }

    constructor(workspace_dir: string) {
        super();
        this._workspace_dir = workspace_dir;
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
                this.set_connection(connection);

                // reject the promise if something wrong happens
                this.on("errorMessage", () => {
                    reject();
                });

                await this.connectRuntime(program);

                // if there is any queued payload, this is the time to send out
                for (let i = 0; i < this._queued_payload.length; i++) {
                    await this.send_payload(this._queued_payload[i]);
                }
                this._queued_payload.length = 0;

                // let the debugger know that we have properly connected and enter interactive mode
                this.sendEvent('stopOnEntry');
                resolve();
            });
        });

        // connect to specified port
        await this._ws.connect(`ws://${this._runtimeIP}:${this._runtimePort}`);
        await promise;
    }

    private set_connection(connection: ws.connection) {
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
                    this.on_breakpoint(resp.payload);
                    break;
                }
                default:
                    // we use token based req-resp here
                    // each response will have a unique token matching with the request
                    // so we don't need to check response type at all
                    const token = resp.token;
                    if (token) {
                        const cb = this._token_callbacks.get(token);
                        if (cb) {
                            cb(resp);
                            this._token_callbacks.delete(token);
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
        await this.send_command("stop");
        this._connected = false;
        await this._connection?.close();
    }

    private add_frame_info(payload: Object) {
        this._current_filename = payload["filename"];
        this._current_line_num = Number.parseInt(payload["line_num"]);

        const instances: Array<any> = payload["instances"];
        for (let i = 0; i < instances.length; i++) {
            const entry = instances[i];
            const local: Object = entry["local"];
            const generator: Object = entry["generator"];
            const instance_id = entry["instance_id"];
            const instance_name = entry["instance_name"];

            // convert them into the format and store them
            const local_variables_raw = new Map<string, string>(Object.entries(local));
            const local_variables = util.convertToDotMap(local_variables_raw);
            // merge this two
            // notice this is used for having multiple instances values shown in the
            // debug window
            const vars = this._current_local_variables.get(instance_id);
            if (vars) {
                vars.push(local_variables);
            } else {
                this._current_local_variables.set(instance_id, [local_variables]);
            }
            const gen_vars = this._current_generator_variables.get(instance_id);
            const new_gen_var_raw = new Map<string, string>(Object.entries(generator));
            const new_gen_var = util.convertToDotMap(new_gen_var_raw);
            if (gen_vars) {
                gen_vars.push(new_gen_var);
            } else {
                this._current_generator_variables.set(instance_id, [new_gen_var]);
            }
            // get instance name
            this._current_generator_names.set(instance_id, instance_name);
        }

        // set time
        this._current_time = payload["time"];
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
            const token = this.get_token();
            // register a callback
            this.add_callback(token, (resp) => {
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
            this.send_bp_location(filename, line, token, column);
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
        const token = this.get_token();
        let promise = new Promise<Array<number>>((resolve) => {
            this.add_callback(token, (resp) => {
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
        await this.send_bp_location(filename, line, token);
        return await promise;
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
        // only time so far
        return [{
            name: "Time",
            value: this._current_time.toString()
        }];
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

    public async setBreakpoint(breakpoint_id: number, expr?: string) {
        const token = this.get_token();
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
            this.add_callback(token, (resp) => {
                if (resp.status === "error") {
                    reject();
                } else {
                    resolve();
                }
            });
        });
        await this.send_payload(payload);
        return promise;
    }

    public async getSimulatorStatus(info_command: string = "breakpoints") {
        // used for debugging only. not actually used by the debug adapter
        const token = this.get_token();
        const payload = {
            "request": true,
            "type": "debugger-info",
            "token": token,
            "payload": {"command": info_command}
        };
        let promise = new Promise<any>((resolve, reject) => {
            this.add_callback(token, (resp) => {
                if (resp.status === "error") {
                    reject();
                } else {
                    resolve(resp.payload);
                }
            });
        });
        await this.send_payload(payload);
        return promise;
    }

    // private methods
    private async send_payload(payload: any) {
        const payload_str = JSON.stringify(payload);
        if (this._connection) {
            await this._connection.send(payload_str);
        } else {
            // put it in the queue
            this._queued_payload.push(payload);
        }
    }

    private async send_command(command: string) {
        const payload = {"request": true, "type": "command", "payload": {"command": command}};
        await this.send_payload(payload);
    }

    private async run(is_step: Boolean) {
        if (this._connected) {
            if (!is_step) {
                await this.send_command("continue");
            } else {
                await this.send_command("step-over");
            }
        } else {
            // inform user that it's not connected to the simulator runtime?
        }
    }

    private async sendRemoveBreakpoints(filename: string) {
        const token = this.get_token();
        return new Promise<void>((resolve, reject) => {
            this.add_callback(token, (resp) => {
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
            this.send_payload(payload);
        });
    }

    private async connectRuntime(file: string) {
        // resolve it to make it absolute path
        if (!path.isAbsolute(file)) {
            file = path.join(this._workspace_dir, file);
        }

        // register callback
        const token = this.get_token();
        let promise = new Promise<void>((resolve, reject) => {
            this.add_callback(token, async (resp) => {
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

        await this.send_connect_message(file, token);
        return promise;
    }

    private on_breakpoint(payload, is_exception = false) {
        this._current_local_variables.clear();
        this._current_generator_variables.clear();
        this._current_generator_names.clear();
        // we will get a list of values
        this.add_frame_info(payload);
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
    private get_token(): string {
        const id = this._token_count++;
        return id.toString();
    }

    private add_callback(token: string, callback: Function) {
        this._token_callbacks.set(token, callback);
    }

    private async send_connect_message(db_filename: string, token: string) {
        const payload = {
            "request": true, "type": "connection", "payload": {
                "db_filename": db_filename,
            },
            "token": token
        };
        await this.send_payload(payload);
    }

    private async send_bp_location(filename: string, line_num: number, token: string, column_num?: number) {
        const payload = {
            "request": true, "type": "bp-location", "token": token,
            "payload": {"filename": filename, "line_num": line_num}
        };
        if (column_num) {
            payload["payload"]["column_num"] = column_num;
        }
        await this.send_payload(payload);
    }

    /**
     * Fire events if the simulator hits a breakpoint
     */
    private fireEventsForBreakPoint() {
        this.sendEvent("stopOnBreakpoint");
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
