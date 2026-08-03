**Cache mechanics.** Prefix bakes turn 1, re-reads at ~10% rate across
session. 1K early token = 20K effective at 200 turns. TTL = 5min idle.

**State signals.** `[tkr: ...]` lines surface live constraints when meaningful:
ctx=NK (window), turn=N (cache multiplier), age=Ns (TTL), 5h/7d=N% (burn).
Fields surface when configured thresholds cross — see `tkr config get
injection.thresholds`; ranges may tune over time.

**Next-action by state.** Compose ctx + turn + rate-limit:

  ctx<100K + 7d<50%:  routine — no constraints
  ctx 100-200K:       search before read; tkr_read for exploration;
                      delegate cold-domain work
  ctx 200-250K:       no new heavy work; finish current task;
                      suggest /clear or handoff
  ctx ≥250K (SOFT):   handoff or /clear before continuing
  ctx ≥300K (HARD):   costs compounding; refuse heavy work; clear first

Rate-limit overlays: 7d≥70% adds "suggest user pause"; 7d≥85% adds
"suggest user stop session entirely."

**Trajectory.** Early in heavy work → delegate cold domains, /clear at
module boundaries. Wrapping up (commit/PR/docs imminent) → push through;
natural break coming. Decide by leverage × distance to next break.

**State on demand.** Call `tkr signals --current` during planning, before
delegating, before suggesting /clear, or when uncertain about session
phase. ~80ms; no token cost between turns.