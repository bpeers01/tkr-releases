// hooks/lib/sessionstart/resident-warm.js
//
// #287 — warm the opt-in resident runtime (#209) from SessionStart.
//
// The problem this fixes is an ordering one, not a capability one. The
// resident client already starts a runtime lazily, but it does so from the
// request path: the first eligible Bash call finds no runtime, pays the full
// fresh-process fallback, AND launches the runtime for next time. So the very
// first Bash call of every session — the one a user is most likely to be
// watching — never benefits, and a short session may never benefit at all.
//
// SessionStart is the earliest point at which the project root is known and no
// Bash call has happened yet, so the runtime's cold start (measured p50 ~54ms
// on the #209 bench box) can be paid in parallel with the user reading the
// session banner and typing their first prompt.
//
// What this module deliberately does NOT do:
//
//   * It does not wait. No connect, no ping, no readiness poll. A runtime that
//     never comes up costs this hook nothing beyond the fork.
//   * It does not introduce lifecycle policy. Singleton lock, 5s start
//     cooldown, request-timeout cooldown, binary-stamp version handoff and
//     idle shutdown all live in resident-client.warm()/maybeStart() and
//     internal/resident, unchanged. This module decides WHEN, not WHETHER the
//     rules apply.
//   * It does not flip the runtime on. TKR_RESIDENT_ENABLED=1 is still
//     required, and TKR_RESIDENT_DISABLED=1 still wins. Defaulting the
//     runtime on is #288 and a separate decision.
//
// Kill switches honored here, in order of breadth:
//   TKR_HOOKS_DISABLED=1   — everything; checked before any work
//   TKR_DISABLED=1         — tkr's hook rewrites are off, so a runtime whose
//                            purpose is serving them should not be conjured
//                            at session start. Note this gate is HERE and not
//                            in resident-client.call(): the request path's
//                            behavior under TKR_DISABLED is pre-existing and
//                            out of scope for #287, so warm-up declines to
//                            add a new starting point rather than removing an
//                            old one.
//   TKR_RESIDENT_DISABLED=1 / absent TKR_RESIDENT_ENABLED — inside warm()

const { warm } = require("../resident-client");
const { hooksDisabled } = require("../stdin-with-timeout");

// warmResidentRuntime is the SessionStart entry point.
//
// Returns the verdict object from warm() (plus a reason of its own for the
// switches checked here) so tests and callers can assert what happened.
// Never throws.
function warmResidentRuntime(opts = {}) {
  try {
    const env = opts.env || process.env;
    // Both spellings: hooksDisabled() reads the real process env (the
    // production path, where session-start.js has already exited before
    // reaching here), and opts.env is what a caller injects.
    if (hooksDisabled() || env.TKR_HOOKS_DISABLED === "1") {
      return { started: false, reason: "hooks_disabled" };
    }
    if (env.TKR_DISABLED === "1") return { started: false, reason: "tkr_disabled" };
    return warm({
      env,
      // CLAUDE_PROJECT_DIR is what SessionStart already trusts for every other
      // project-scoped decision in this hook. warm() runs it through the same
      // projectRootFor walk the request path uses, so the key it derives is
      // the key the first Bash call will look under — if those two disagreed
      // the warm-up would start a runtime nothing ever finds.
      cwd: opts.cwd || env.CLAUDE_PROJECT_DIR || process.cwd(),
      projectRoot: opts.projectRoot,
    });
  } catch {
    return { started: false, reason: "error" };
  }
}

module.exports = { warmResidentRuntime };
