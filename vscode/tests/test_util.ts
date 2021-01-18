import {assert, expect} from "chai";
import * as util from "../src/util";

describe('util', function () {
    it('test convert to dot', () => {
        const input1 = "a[0][1]";
        const result1 = util.convertToDot(input1);
        expect(result1).eq("a.0.1");

        const input2 = "a[0].a";
        const result2 = util.convertToDot(input2);
        expect(result2).eq("a.0.a");

        const input3 = "a.0.1";
        const result3 = util.convertToDot(input3);
        expect(result3).eq(input3);
    });

    it("test convert to dot map", () => {
        const inputs = new Map<string, string>([["a[0][0]", "1"], ["a[0][1]", "2"]]);
        const result = util.convertToDotMap(inputs);

        const entry1 = result.get("a.0.0");
        assert(entry1);
        expect(entry1).eq("1");
        const entry2 = result.get("a.0.1");
        assert(entry2);
        expect(entry2).eq("2");
    });
});