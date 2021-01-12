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
    return Math.floor(Math.random() * (max - min)  + min);
}


function start_mock_server(port, extra_flags?: Array<string>) {
    const root = path.dirname(path.dirname(__filename));
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

        await sleep(1000);

        assert(closed, "Unable to stop simulation");
        expect(p.exitCode).eq(0);
    });

    it("test bp location request", async () => {
        const port = get_random_port();
        let p = start_mock_server(port, ["+NO_EVAL"]);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);
        runtime.on("errorMessage", (msg) => {
            assert(false, msg);
        });

        let returned = false;
        await sleep(100);
        await runtime.start("ignore");
        await sleep(100);
        await runtime.getBreakpoints("/tmp/test.py", 1, (bps) => {
            expect(bps.length).eq(1);
            returned = true;
        });
        await sleep(100);
        expect(returned).eq(true);

        // no breakpoints
        returned = false;
        await runtime.getBreakpoints("/tmp/test.py", 42, (bps) => {
            expect(bps.length).eq(0);
            returned = true;
        });

        await sleep(100);
        expect(returned).eq(true);

        p.kill();
    });

    it("test add/remove breakpoint", async () => {
        const port = get_random_port();
        let p = start_mock_server(port, ["+NO_EVAL"]);

        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.setRuntimePort(port);
        runtime.on("errorMessage", (msg) => {
            assert(false, msg);
        });

        await sleep(100);
        await runtime.start("ignore");
        await sleep(100);

        await runtime.setBreakpoint(0);
        await sleep(100);

        let returned = false;
        await runtime.getSimulatorStatus("breakpoints", (resp) => {
            returned = true;
            expect(resp.payload.breakpoints.length).eq(1);
        });
        await sleep(100);
        expect(returned).eq(true);

        // test remove
        returned = false;
        await runtime.clearBreakpoints("/tmp/test.py");
        await sleep(100);
        await runtime.getSimulatorStatus("breakpoints", (resp) => {
            returned = true;
            expect(resp.payload.breakpoints.length).eq(0);
        });
        await sleep(100);
        expect(returned).eq(true);

        p.kill();
    });
});