import {assert, expect} from "chai";
import * as HGDBRuntime from "../src/hgdbRuntime";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";


function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function get_random_port() {
    const min = 20000;
    const max = 60000;
    return Math.floor(Math.random() * (max - min) + min);
}


function start_mock_server(port, extra_flags?: Array<string>) {
    // the root is the the very top of the repo, which is shared by all debuggers for testing
    const root = path.dirname(path.dirname(path.dirname(__filename)));
    const build_dir = path.join(root, "build");
    const exe = path.join(build_dir, "tests", "test_debug_server");
    if (!extra_flags) {
        extra_flags = [];
    }
    let flags = [`+DEBUG_PORT=${port}`, "+DEBUG_LOG", "+DEBUG_NO_DB"];
    flags = flags.concat(extra_flags);
    assert(fs.existsSync(exe), "Unable to find " + path.basename(exe));
    return child_process.spawn(exe, flags);
}

async function set_breakpoint(runtime: HGDBRuntime.HGDBRuntime, breakpoint_id: number) {
    runtime.on("errorMessage", (msg) => {
        assert(false, msg);
    });

    await sleep(100);
    await runtime.start("ignore");

    await runtime.setBreakpoint(breakpoint_id);
}


describe('runtime', function () {
    it('test connect/stop', async () => {
        const port = get_random_port();
        let p = start_mock_server(port, ["+NO_EVAL"]);
        let closed = false;
        p.on("close", () => {
            // for some reason the exit code is null
            closed = true;
        });
        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);
        runtime.on("errorMessage", (msg) => {
            assert(false, msg);
        });
        await sleep(100);
        // don't know how to get a free port natively in node, since it's not the same process
        // for now just use a random port
        await runtime.start("ignore");
        runtime.on("simulatorConnected", async () => {
            await runtime.stop();
        });

        await sleep(100);

        assert(closed, "Unable to stop simulation");
        expect(p.exitCode).eq(0);
    });

    it("test bp location request", async () => {
        const port = get_random_port();
        let p = start_mock_server(port, ["+NO_EVAL"]);
        const num_instances = 2;

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);
        runtime.on("errorMessage", (msg) => {
            assert(false, msg);
        });

        await sleep(100);
        await runtime.start("ignore");
        let bps = await runtime.getBreakpoints("/tmp/test.py", 1);
        expect(bps.length).eq(num_instances);

        // no breakpoints
        bps = await runtime.getBreakpoints("/tmp/test.py", 42);
        expect(bps.length).eq(0);

        p.kill();
    });

    it("test add/remove breakpoint", async () => {
        const port = get_random_port();
        let p = start_mock_server(port, ["+NO_EVAL"]);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await set_breakpoint(runtime, 0);

        let payload = await runtime.getSimulatorStatus("breakpoints");
        expect(payload.breakpoints.length).eq(1);

        // test remove
        await runtime.clearBreakpoints("/tmp/test.py");
        payload = await runtime.getSimulatorStatus("breakpoints");
        expect(payload.breakpoints.length).eq(0);

        p.kill();
    });

    it("test breakpoint hit/continue", async () => {
        const port = get_random_port();
        let p = start_mock_server(port);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await set_breakpoint(runtime, 0);
        await runtime.continue();

        // wait a tiny bit for the server to send breakpoint hit
        await sleep(100);
        // current scope should be set up properly
        const instance_id = 1;
        const locals = runtime.getCurrentLocalVariables();
        const instance_local = locals.get(instance_id);
        assert(instance_local !== undefined);
        if (instance_local) {
            expect(instance_local[0].get("a")).eq("1");
        }
        // test generator variables as well
        const gen_vars = runtime.getCurrentGeneratorVariables();
        const instance_gen_var = gen_vars.get(instance_id);
        assert(instance_gen_var !== undefined);
        if (instance_gen_var) {
            expect(instance_gen_var[0].get("a")).eq("1");
        }
        p.kill();
    });

    it("test step over", async () => {
        const port = get_random_port();
        let p = start_mock_server(port);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await set_breakpoint(runtime, 0);
        await runtime.step();

        // wait a tiny bit for the server to send breakpoint hit
        await sleep(100);
        // current scope should be set up properly
        let instance_id = 1;
        let locals = runtime.getCurrentLocalVariables();
        assert(locals.has(instance_id));

        // next step
        await runtime.step();
        // wait a tiny bit for the server to send breakpoint hit
        await sleep(100);
        instance_id = 2;
        locals = runtime.getCurrentLocalVariables();
        assert(locals.has(instance_id));

        p.kill();
    });

    it("test evaluate", async () => {
        const port = get_random_port();
        let p = start_mock_server(port);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await sleep(100);
        await runtime.start("ignore");
        let result = await runtime.handleREPL("1 + 41");
        expect(result).eq("42");
        // set scope
        await runtime.handleREPL("scope mod");
        result = await runtime.handleREPL("1 + a");
        expect(result).eq("2");
        p.kill();
    });


    it("test step back", async () => {
        const port = get_random_port();
        let p = start_mock_server(port);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await sleep(100);
        await runtime.start("ignore");

        await sleep(100);
        await runtime.setBreakpoint(3);
        await runtime.continue();
        await sleep(200);
        const ln1 = runtime.currentLineNum();
        expect(ln1).eq(5);
        await runtime.stepBack();
        await sleep(200);
        const ln2 = runtime.currentLineNum();
        expect(ln2).eq(2);

        p.kill();
    });

    it("test set value", async () => {
        const port = get_random_port();
        let p = start_mock_server(port);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);

        await sleep(100);
        await runtime.start("ignore");

        await sleep(100);
        await runtime.setBreakpoint(0);
        await runtime.continue();
        await sleep(200);
        // we are at breakpoints
        const res = await runtime.setValue("a", 42, 1, false);
        expect(res).eq(true);
        await runtime.continue();
        await sleep(200);
        const result = await runtime.handleREPL("1 + a", "1");
        expect(result).eq("43");
        p.kill();
    });

});