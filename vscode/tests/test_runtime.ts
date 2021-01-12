// import {expect} from "chai";
import * as HGDBRuntime from "../src/hgdbRuntime";


describe('runtime', function() {
    it('test_connect', function() {
        let runtime = new HGDBRuntime.HGDBRuntime("/ignore");
        runtime.getGlobalVariables();
    });
});