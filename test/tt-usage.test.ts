import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { localZoneTime, usageResets } from "../src/server/extensions/_tt-usage-helpers.ts";

test("usage resets omit unused windows and keep the limiting window reset", () => {
    assert.deepEqual(
        usageResets(
            { percent: 0, resetsAtLocal: "date A", resetsIn: "5h" },
            { percent: 18, resetsAtLocal: "date B", resetsIn: "5d" },
        ),
        [
            {
                label: "wk",
                resetsAtLocal: "date B",
                resetsIn: "5d",
            },
        ],
    );
});

test("usage resets label both windows when both have usage", () => {
    assert.deepEqual(
        usageResets(
            { percent: 8, resetsAtLocal: "date C", resetsIn: "3h" },
            { percent: 1, resetsAtLocal: "date B", resetsIn: "5d" },
        ),
        [
            {
                label: "5h",
                resetsAtLocal: "date C",
                resetsIn: "3h",
            },
            {
                label: "wk",
                resetsAtLocal: "date B",
                resetsIn: "5d",
            },
        ],
    );
});

test("usage reset timestamps keep the server's zone label", () => {
    const ms = Date.UTC(2026, 10, 7, 21, 29);
    const zone = "America/Edmonton";
    const serverTime = execFileSync(
        "date",
        ["-d", `@${Math.floor(ms / 1000)}`, "+%b %-d, %H:%M %Z"],
        {
            env: { ...process.env, TZ: zone },
            encoding: "utf8",
        },
    ).trim();

    assert.equal(localZoneTime(ms, zone), serverTime);
});
