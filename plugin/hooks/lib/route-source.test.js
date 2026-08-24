#!/usr/bin/env node
// INV-083 — system-envelope detection, the JS mirror of
// internal/route.IsSystemEnvelope. This is the guard that lets
// routeInjectContext's legacy TKR_ROUTE_SYNC=0 path skip `tkr route
// classify` for text no user ever typed.
//
// Run: node --test hooks/lib/route-source.test.js

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { isSystemEnvelope } = require("./route-source.js");

test("isSystemEnvelope detects a leading task-notification tag", () => {
  assert.strictEqual(
    isSystemEnvelope("<task-notification>\nBackground task finished.\n</task-notification>"),
    true,
  );
});

test("isSystemEnvelope detects a leading system-reminder tag", () => {
  assert.strictEqual(
    isSystemEnvelope("<system-reminder>\nStop hook keepalive.\n</system-reminder>"),
    true,
  );
});

test("isSystemEnvelope is case-insensitive", () => {
  assert.strictEqual(isSystemEnvelope("<TASK-NOTIFICATION>done</TASK-NOTIFICATION>"), true);
});

test("isSystemEnvelope tolerates leading whitespace", () => {
  assert.strictEqual(isSystemEnvelope("  \n<system-reminder>ping</system-reminder>"), true);
});

test("isSystemEnvelope requires the tag to be LEADING, not merely present", () => {
  assert.strictEqual(
    isSystemEnvelope("please summarize <system-reminder> mid-sentence"),
    false,
  );
});

test("isSystemEnvelope is false for a slash command", () => {
  assert.strictEqual(isSystemEnvelope("/tkr:handoff"), false);
});

test("isSystemEnvelope is false for ordinary prose", () => {
  assert.strictEqual(isSystemEnvelope("please fix the failing test"), false);
});

test("isSystemEnvelope is false for empty or non-string input", () => {
  assert.strictEqual(isSystemEnvelope(""), false);
  assert.strictEqual(isSystemEnvelope(undefined), false);
  assert.strictEqual(isSystemEnvelope(null), false);
});
