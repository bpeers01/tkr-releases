// Tests for the RT: route-class truncation block in hooks/statusline.sh
// (INV-106). Before this fix, TKR_ROUTE_CLASS was blindly sliced to 12
// runes with no word boundary and no cut marker, so `localized_edit`
// rendered as `RT:localized_ed` — a truncated string that reads as a
// plausible-but-invented class name, indistinguishable from a real one.
//
// Fix: RT_CLASS_MAX (21) covers every class route.ReachableProfiles()
// can actually produce today (internal/route/classify.go), so real
// class names render whole. Anything still over budget is cut back to
// the last snake_case boundary within budget (or hard-cut if there is
// none) and marked with a trailing "...".
//
// Strategy: mirror the RT_BADGE block from statusline.sh as a literal
// string (same convention as statusline-mode-resolve.test.js) and
// shell-eval it with synthetic TKR_ROUTE_CLASS / TKR_ROUTE_EFFORT
// inputs. Any divergence between this snippet and the real script is a
// bug — keep both in lockstep. Skips on hosts without bash.
//
// Run: node --test hooks/statusline-rt-truncate.test.js

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");

function which(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

const HAVE_BASH = which("bash");

// Mirror of the RT_BADGE block in hooks/statusline.sh.
const RT_SNIPPET = `
RT_CLASS_MAX=21
RT_BADGE=""
if [ -n "\${TKR_ROUTE_EFFORT:-}" ]; then
  RT_CLASS_SHORT="$TKR_ROUTE_CLASS"
  if [ "\${#RT_CLASS_SHORT}" -gt "$RT_CLASS_MAX" ]; then
    RT_TRUNC="\${RT_CLASS_SHORT:0:$RT_CLASS_MAX}"
    RT_BOUNDARY="\${RT_TRUNC%_*}"
    if [ -n "$RT_BOUNDARY" ] && [ "$RT_BOUNDARY" != "$RT_TRUNC" ]; then
      RT_CLASS_SHORT="\${RT_BOUNDARY}..."
    else
      RT_CLASS_SHORT="\${RT_TRUNC}..."
    fi
  fi
  if [ -n "$RT_CLASS_SHORT" ]; then
    RT_BADGE="RT:\${RT_CLASS_SHORT}→\${TKR_ROUTE_EFFORT}"
  else
    RT_BADGE="RT:\${TKR_ROUTE_EFFORT}"
  fi
fi
printf '%s' "$RT_BADGE"
`;

function runRT(routeClass, routeEffort) {
  const r = spawnSync("bash", ["-c", RT_SNIPPET], {
    env: Object.assign({}, process.env, {
      TKR_ROUTE_CLASS: routeClass,
      TKR_ROUTE_EFFORT: routeEffort,
    }),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`bash exit ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

// The longest class route.ReachableProfiles() can produce today
// (internal/route/classify.go). Every real class must render whole.
const REAL_CLASSES = [
  "bash_filter",
  "security_review",
  "ambiguous_debug",
  "repo_wide_refactor",
  "summarization_docs",
  "architecture_design",
  "status_classification",
  "localized_edit",
];

test("every real route class renders whole, never truncated", {
  skip: !HAVE_BASH,
}, () => {
  for (const cls of REAL_CLASSES) {
    const out = runRT(cls, "high");
    assert.strictEqual(out, `RT:${cls}→high`, `class ${cls} must not be cut`);
  }
});

// INV-106 reproducer: the exact bug reported (`localized_edit` cut mid-
// word to `localized_ed`) must not recur even at the OLD 12-rune budget
// distance — the fix is verified against the real 21-rune budget, where
// this class simply fits.
test("localized_edit no longer arrives as the invented localized_ed", {
  skip: !HAVE_BASH,
}, () => {
  const out = runRT("localized_edit", "medium");
  assert.strictEqual(out, "RT:localized_edit→medium");
  assert.ok(!out.includes("localized_ed→"), "must not reproduce the mid-word cut");
});

test("a class past budget is cut at a snake_case boundary and marked", {
  skip: !HAVE_BASH,
}, () => {
  // 43 chars, well past the 21 budget, with underscores throughout.
  const out = runRT("a_very_long_hypothetical_future_class_name", "high");
  const arrowIdx = out.indexOf("→");
  assert.ok(arrowIdx > -1, "badge must carry the arrow separator");
  const classPart = out.slice(3, arrowIdx);
  assert.ok(classPart.endsWith("..."), "cut must be marked");
  assert.ok(!classPart.endsWith("_..."), "boundary cut must not leave a trailing underscore before the marker");
  assert.ok(
    classPart.length <= 21 + 3,
    `cut class+marker (${classPart}) must not exceed budget+marker length`,
  );
});

test("a class past budget with no boundary in range still gets a marked hard cut", {
  skip: !HAVE_BASH,
}, () => {
  const out = runRT("nounderscoreatallreallylongclassnamehere", "low");
  const classPart = out.slice(3, out.indexOf("→"));
  assert.strictEqual(classPart, "nounderscoreatallreal...", "hard cut at budget, marked");
});

test("an empty route class renders effort alone, no bare RT: dash", {
  skip: !HAVE_BASH,
}, () => {
  const out = runRT("", "high");
  assert.strictEqual(out, "RT:high");
});

test("no route effort means no badge at all", {
  skip: !HAVE_BASH,
}, () => {
  const out = runRT("localized_edit", "");
  assert.strictEqual(out, "");
});
