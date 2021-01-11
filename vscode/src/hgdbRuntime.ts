import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import * as path from 'path';
import * as request from 'request';
import * as express from 'express';
import * as http from 'http';
import * as bodyParser from 'body-parser';
import * as utils from './utils';


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
    private _debuggerPort: number = 8889;
    private _connected = false;
    private _app: express.Application;

    private _current_filename: string;
    private _current_line_num: number;

    private _srcPath: string = "";
    private _dstPath: string = "";

    public current_filename() { return this._current_filename; }
    public current_num() { return this._current_line_num; }
    public getCurrentLocalVariables() { return this._current_local_variables; }
    public getCurrentGeneratorVariables() { return this._current_generator_variables; }
    public getCurrentGeneratorNames() { return this._current_generator_names; }

    public getCurrentBreakpointInstanceId() { return this._current_breakpoint_instance_id; }

    public setRuntimeIP(ip: string) { this._runtimeIP = ip; }
    public setRuntimePort(port: number) { this._runtimePort = port; }

    public setSrcPath(path: string) { this._srcPath = path; }
    public setDstPath(path: string) { this._dstPath = path; }


    constructor() {
        super();
    }

    private on_breakpoint(req, res, is_exception = false) {
        this._current_local_variables.clear();
        this._current_generator_variables.clear();
        this._current_generator_names.clear();
        // we will get a list of values
        var payload: Array<string> = req.body;
        const id = this.add_frame_info(payload);
        // recreate threads
        if (!is_exception) {
            this.fireEventsForBreakPoint(id);
        } else {
            this.fireEventsForException();
        }
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean) {
        // setup the local server
        this._app = express();
        this._app.use(bodyParser.json());
        this._app.post("/status/breakpoint", (req, res) => {
            this.on_breakpoint(req, res);
        });

        this._app.post("/status/step", (req, res) => {
            this.on_breakpoint(req, res);
        });

        this._app.post("/status/exception", (req, res) => {
            this.on_breakpoint(req, res, true);
        });

        
        const ip = await utils.get_ip();
        var server = http.createServer(this._app);
        server.listen(undefined, ip, () => {

            const address: any = server.address();
            this._debuggerPort = address.port;

            // connect to the server
            this.connectRuntime(program);
            if (stopOnEntry) {
                this.sendEvent('stopOnEntry');
            }
        });

        this._app.post("/stop", (_, __) => {
            server.close();
            this.sendEvent('end');
        });

    }

    public async stop() {
        request.post(`http://${this._runtimeIP}:${this._runtimePort}/stop`);
    }

    public async getGlobalVariables() {
        var promises: Array<Promise<{ name: string, value: any }>> = [];
        promises.push(new Promise((resolve, reject) => {
            request.get(`http://${this._runtimeIP}:${this._runtimePort}/time`, (_, res, body) => {
                if (res.statusCode === 200) {
                    // update to the time if possible
                    if (typeof this._onTimeChange !== 'undefined') {
                        this._onTimeChange(body);
                    }
                    resolve({ name: "Time", value: body });
                } else {
                    reject("Unknown value");
                }
            });
        }));

        var vars = await Promise.all(promises);
        return vars;
    }

    private add_frame_info(payload: Object) {
        var local: Object = payload["local"];
        var generator: Object = payload["generator"];
        var id = Number.parseInt(payload["id"]);
        var instance_id = Number.parseInt(payload["instance_id"]);
        this._current_filename = payload["filename"];
        this._current_line_num = Number.parseInt(payload["line_num"]);
        this._current_breakpoint_instance_id = instance_id;
        // convert them into the format and store them
        const local_variables = new Map<string, string>(Object.entries(local));
        // merge this two
        var vars = this._current_local_variables.get(instance_id);
        const new_var = new Map<string, string>([...local_variables]);
        if (vars) {
            vars.push(new_var);
        } else {
            this._current_local_variables.set(instance_id, [new_var]);
        }
        var gen_vars = this._current_generator_variables.get(instance_id);
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

    private run(is_step: Boolean) {
        if (this._connected) {
            if (!is_step) {
                // send the continue commend
                if (this._connected) {
                    request.post(`http://${this._runtimeIP}:${this._runtimePort}/continue`);
                }

            } else {
                // send the step command
                if (this._connected) {
                    request.post(`http://${this._runtimeIP}:${this._runtimePort}/step_over`);
                }
            }
        } else {
            // inform user that it's not connected to the simulator runtime
        }
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
    public async verifyBreakpoint(filename: string, line: number, column?: number, expr?: string): Promise<Array<HGDBBreakpoint>> {
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
                            let bp = <HGDBBreakpoint>{ valid: true, line, id: e.id, filename: filename, column: e.col };
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
     * Clear breakpoint in file with given line.
     */
    public async clearBreakPoint(filename: string, line: number) {
        // get the absolute path
        var filename = path.resolve(filename);
        var bp: HGDBBreakpoint | undefined = undefined;
        this.sendRemoveBreakpoint(filename, line);

        return bp;
    }

    /*
     * Clear all breakpoints for file.
     */
    public async clearBreakpoints(filename: string) {
        // find the filename
        var filename = path.resolve(filename);
        await this.sendRemoveBreakpoints(filename);
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

    public stack(instance_id: number) {
        // we only have one stack frame
        var frames: Array<any> = [];
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



    // get hierarchy
    public getHierarchy(handle: string) {
        var url = `http://${this._runtimeIP}:${this._runtimePort}/hierarchy/${handle}`;
        return new Promise((resolve, reject) => {
            request.post(url, (_, res, __) => {
                if (res.statusCode === 200) {
                    const value = JSON.parse(res.body);
                    const values = value.value;
                    if (typeof values !== 'undefined') {
                        resolve({ name: value.name, value: values.value });
                    } else {
                        resolve({ name: value.name });
                    }
                } else {
                    reject();
                }
            });
        });
    }

    public sendBreakpoint(breakpoint_id: number, expr?: string) {
        let url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
        let payload = { id: breakpoint_id, expr: expr || "" };
        let options = {
            method: "post",
            body: payload,
            json: true,
            url: url
        };
        request(options);
    }

    // private methods

    private sendRemoveBreakpoint(filename: string, line_num: Number) {
        var payload = { filename: filename, line_num: line_num };
        var url = `http://${this._runtimeIP}:${this._runtimePort}/breakpoint`;
        var options = {
            method: "delete",
            body: payload,
            json: true,
            url: url
        };
        request(options);
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
        var payload = { ip: ip, port: this._debuggerPort, database: file };
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
                                vscode.workspace.workspaceFolders.length : 0, null, { uri: vscode.Uri.file(base_dir) });
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
