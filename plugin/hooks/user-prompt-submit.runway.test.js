#!/usr/bin/env node
// PACE-001 tests: the injected state line carries time-to-reset and a runway
// ratio alongside 7d=N%, so the model stops reading a nearly-expired window
// as an emergency. Mirrors internal/signals/pace_test.go.
//
// Run: node hooks/user-prompt-submit.runway.test.js

const test = require("node:test");
const assert = require("node:assert");

const { runwaySuffix } = require("./user-prompt-submit.js");

const NOW = 1786000000; // fixed clock; never Date.now() in assertions
const HOUR = 3600;
const DAY = 24 * HOUR;

test("runway: 85% with 11h left reads as budget to spare", () => {
  // 15% of budget covering 6.7% of the window.
  assert.strictEqual(
    runwaySuffix(85, NOW + 11 * HOUR + 17 * 60, NOW),
    " (rst11h rw2.2x)",
  );
});

test("runway: same percentage early in the window is a real emergency", () => {
  assert.strictEqual(runwaySuffix(85, NOW + 6 * DAY, NOW), " (rst6d rw0.2x)");
});

test("runway: exactly on pace reads 1.0x", () => {
  assert.strictEqual(runwaySuffix(50, NOW + 3.5 * DAY, NOW), " (rst4d rw1.0x)");
});

test("runway: absent resets_at yields no suffix", () => {
  assert.strictEqual(runwaySuffix(85, undefined, NOW), "");
  assert.strictEqual(runwaySuffix(85, 0, NOW), "");
  assert.strictEqual(runwaySuffix(85, null, NOW), "");
});

test("runway: a reset already in the past yields no suffix", () => {
  // The window has rolled; the percentage is stale, so refuse rather
  // than compute against it.
  assert.strictEqual(runwaySuffix(85, NOW - HOUR, NOW), "");
});

test("runway: an implausibly distant reset yields no suffix", () => {
  assert.strictEqual(runwaySuffix(85, NOW + 9 * DAY, NOW), "");
});

test("runway: exhausted budget reads 0.0x, not unknown", () => {
  assert.strictEqual(runwaySuffix(100, NOW + 24 * HOUR, NOW), " (rst24h rw0.0x)");
});

test("runway: hours below 48, days above", () => {
  assert.ok(runwaySuffix(50, NOW + 47 * HOUR, NOW).includes("rst47h"));
  assert.ok(runwaySuffix(50, NOW + 49 * HOUR, NOW).includes("rst2d"));
});
