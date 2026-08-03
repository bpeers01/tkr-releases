# tkr unified statusline badge (PowerShell variant).
# See statusline.sh for full documentation.
#
# L-09 (INV-047): rate-limit propagation mirrors statusline.sh — CC's
# authoritative seven_day_pct / five_hour_pct are read from stdin and
# merge-written into $TelemetryFile (see CC-RATELIMIT-001 block below)
# so downstream consumers see real rate-limits, not tkr's stale savings
# ratio.
#
# INV-048: seven_day_resets_at / five_hour_resets_at ride the same
# merge-write, converted to epoch seconds (see ConvertTo-EpochSeconds
# below) — CC may send resets_at as epoch seconds or an ISO8601 string.

$TkrStateDir = if ($env:TKR_STATE_DIR) { $env:TKR_STATE_DIR } else { Join-Path $HOME ".tkr" }
$BrevityFlag = Join-Path $TkrStateDir "brevity-mode"

# Read CC's stdin (JSON) to extract session_id. Without sid scoping, the
# statusline reads the previous session's payload on a fresh /clear and
# emits stale [tkr: ...] state. Best-effort: empty stdin → unscoped path.
$StdinData = ""
if (-not [Console]::IsInputRedirected) {
    # No stdin available — nothing to read.
} else {
    try {
        $StdinData = [Console]::In.ReadToEnd()
    } catch {
        $StdinData = ""
    }
}

$SessionId = ""
if ($StdinData) {
    try {
        $stdinJson = $StdinData | ConvertFrom-Json
        if ($stdinJson.session_id) { $SessionId = [string]$stdinJson.session_id }
    } catch {
        $SessionId = ""
    }
}

# Export sid so `tkr` subprocesses inherit the per-session scope.
if ($SessionId) { $env:TKR_SESSION_ID = $SessionId }

# Per-session telemetry path. tkr owns slug + sid normalization so the Go
# writer, JS hooks, and shell agree on a single filename across platforms.
# Fallback to the per-session basename when `tkr` is missing.
$TelemetryFile = $env:TKR_STATUSLINE_PATH
if (-not $TelemetryFile) {
    try {
        $TelemetryFile = & tkr statusline-path 2>$null
    } catch {
        $TelemetryFile = $null
    }
}
if (-not $TelemetryFile) {
    if ($SessionId) {
        $TelemetryFile = Join-Path ([System.IO.Path]::GetTempPath()) "claude-statusline-$SessionId.json"
    } else {
        $TelemetryFile = Join-Path ([System.IO.Path]::GetTempPath()) "claude-statusline.json"
    }
}

# ── resets_at helpers (INV-048) ──────────────────────────────────────
# ConvertTo-EpochSeconds: CC has been observed sending
# rate_limits.*.resets_at as either epoch seconds (number) or an ISO8601
# timestamp (string, with or without a trailing Z). Normalize to epoch
# seconds (int64) either way — mirrors normalize_resets_at() in
# statusline.sh — so downstream Go/JS consumers do one comparison, not
# per-language date parsing. Returns $null when the value is missing or
# unparseable.
function ConvertTo-EpochSeconds {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [double] -or $Value -is [int] -or $Value -is [long]) {
        return [long][Math]::Round([double]$Value)
    }
    $s = [string]$Value
    if ($s -match '^-?[0-9]+(\.[0-9]+)?$') {
        return [long][Math]::Round([double]$s)
    }
    # ISO8601 path: strip a trailing Z (if present) and force UTC — CC's
    # rate-limit windows are always UTC-anchored, and treating the value
    # as UTC gives a stable result regardless of whether CC included Z.
    try {
        $stripped = $s.TrimEnd('Z')
        $dt = [DateTime]::Parse(
            $stripped,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        return [DateTimeOffset]::new($dt, [TimeSpan]::Zero).ToUnixTimeSeconds()
    } catch {
        return $null
    }
}

# Test-ResetsAtSane: reject negative or absurdly-far-future values (>60
# days out) rather than persisting garbage a badge would render as
# nonsense.
function Test-ResetsAtSane {
    param([long]$Epoch)
    if ($Epoch -lt 0) { return $false }
    $nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $maxEpoch = $nowEpoch + (60 * 24 * 3600)
    if ($Epoch -gt $maxEpoch) { return $false }
    return $true
}

# Format-ResetsCountdown (INV-048a): humanizes a remaining-seconds count
# into a "2d9h" / "9h" / "45m" countdown badge, mirroring
# humanize_countdown() in statusline.sh. Caller gates on Seconds > 0.
function Format-ResetsCountdown {
    param([long]$Seconds)
    if ($Seconds -ge 86400) {
        $d = [Math]::Floor($Seconds / 86400)
        $h = [Math]::Floor(($Seconds % 86400) / 3600)
        return "${d}d${h}h"
    } elseif ($Seconds -ge 3600) {
        return "$([Math]::Floor($Seconds / 3600))h"
    } elseif ($Seconds -ge 60) {
        return "$([Math]::Floor($Seconds / 60))m"
    } else {
        return "${Seconds}s"
    }
}

# ── Persist CC's authoritative rate-limit pct (CC-RATELIMIT-001) ────
# Without this, $TelemetryFile's seven_day_pct stays whatever tkr's
# statusline-update last wrote (savings ratio, not real rate-limit).
# Downstream consumers (user-prompt-submit stateLineContext, mode-auto,
# signals package) read that file expecting authoritative pressure.
# Merge-safe: preserves any other keys. Reuses $stdinJson parsed above
# for session_id — API-key accounts emit no rate_limits, so $StdinSevenDay
# stays $null and this block is a no-op (never clobbers a good snapshot).
#
# INV-048: seven_day_resets_at / five_hour_resets_at ride along in the
# same merge, each independently guarded — absent/null/malformed input
# for either means that key is left untouched (existing value survives).
$StdinSevenDay = $null
$StdinFiveHour = $null
$StdinSevenDayResetsRaw = $null
$StdinFiveHourResetsRaw = $null
if ($stdinJson -and $stdinJson.rate_limits) {
    if ($null -ne $stdinJson.rate_limits.seven_day.used_percentage) {
        $StdinSevenDay = [double]($stdinJson.rate_limits.seven_day.used_percentage)
    }
    if ($null -ne $stdinJson.rate_limits.five_hour.used_percentage) {
        $StdinFiveHour = [double]($stdinJson.rate_limits.five_hour.used_percentage)
    }
    if ($null -ne $stdinJson.rate_limits.seven_day.resets_at) {
        $StdinSevenDayResetsRaw = $stdinJson.rate_limits.seven_day.resets_at
    }
    if ($null -ne $stdinJson.rate_limits.five_hour.resets_at) {
        $StdinFiveHourResetsRaw = $stdinJson.rate_limits.five_hour.resets_at
    }
}

if ($null -ne $StdinSevenDay) {
    # Clamp to [0,100] — CC has been observed to emit malformed
    # percentages (e.g. scientific notation like 1.1e+19); anything out
    # of range collapses to 0 rather than rendering digit-soup
    # downstream. Range-check on the double BEFORE casting to [int] —
    # casting an out-of-Int32-range double throws OverflowException.
    $sd7Rounded = [Math]::Round($StdinSevenDay)
    if ($sd7Rounded -lt 0 -or $sd7Rounded -gt 100) { $sd7 = 0 } else { $sd7 = [int]$sd7Rounded }
    $sd5 = 0
    if ($null -ne $StdinFiveHour) {
        $sd5Rounded = [Math]::Round($StdinFiveHour)
        if ($sd5Rounded -lt 0 -or $sd5Rounded -gt 100) { $sd5 = 0 } else { $sd5 = [int]$sd5Rounded }
    }

    $sd7Resets = $null
    if ($null -ne $StdinSevenDayResetsRaw) {
        $epoch = ConvertTo-EpochSeconds $StdinSevenDayResetsRaw
        if ($null -ne $epoch -and (Test-ResetsAtSane $epoch)) { $sd7Resets = $epoch }
    }
    $sd5Resets = $null
    if ($null -ne $StdinFiveHourResetsRaw) {
        $epoch = ConvertTo-EpochSeconds $StdinFiveHourResetsRaw
        if ($null -ne $epoch -and (Test-ResetsAtSane $epoch)) { $sd5Resets = $epoch }
    }

    $existing = [PSCustomObject]@{}
    if (Test-Path $TelemetryFile) {
        try {
            $cur = Get-Content $TelemetryFile -Raw
            if ($cur) { $existing = $cur | ConvertFrom-Json }
        } catch {
            $existing = [PSCustomObject]@{}
        }
    }

    if ($existing.PSObject.Properties.Match('seven_day_pct').Count -gt 0) {
        $existing.seven_day_pct = $sd7
    } else {
        $existing | Add-Member -NotePropertyName 'seven_day_pct' -NotePropertyValue $sd7
    }
    if ($existing.PSObject.Properties.Match('five_hour_pct').Count -gt 0) {
        $existing.five_hour_pct = $sd5
    } else {
        $existing | Add-Member -NotePropertyName 'five_hour_pct' -NotePropertyValue $sd5
    }
    if ($null -ne $sd7Resets) {
        if ($existing.PSObject.Properties.Match('seven_day_resets_at').Count -gt 0) {
            $existing.seven_day_resets_at = $sd7Resets
        } else {
            $existing | Add-Member -NotePropertyName 'seven_day_resets_at' -NotePropertyValue $sd7Resets
        }
    }
    if ($null -ne $sd5Resets) {
        if ($existing.PSObject.Properties.Match('five_hour_resets_at').Count -gt 0) {
            $existing.five_hour_resets_at = $sd5Resets
        } else {
            $existing | Add-Member -NotePropertyName 'five_hour_resets_at' -NotePropertyValue $sd5Resets
        }
    }

    try {
        $tmpFile = "${TelemetryFile}.tmp"
        $existing | ConvertTo-Json -Compress | Set-Content -Path $tmpFile -NoNewline
        Move-Item -Path $tmpFile -Destination $TelemetryFile -Force
    } catch {}
}

# ── Persist CC's live model (MODEL-LAG-001) ──────────────────────────
# Mirrors the MODEL_PERSIST block in statusline.sh — see the rationale
# there. Short version: the payload's `model_id` is the transcript's last
# ASSISTANT turn, which at UserPromptSubmit time is the PREVIOUS turn's
# model, so routing misses the first prompt of a session and the prompt
# after a `/model` switch. CC hands the statusline the live model on
# every render; persist it so routing can prefer it.
#
# This script had no model handling at all, so the parse comes with it.
# The two strips match statusline.sh's ("Claude " prefix, " (1M context)"
# suffix) so both platforms write the same string for the same input —
# route.NormalizeModel also strips them, but agreeing here keeps the
# payload comparable across hosts.
#
# Own block, not folded into the rate-limit merge above: that one is
# gated on rate_limits, which API-key accounts never emit.
$ModelDisplay = ""
if ($stdinJson -and $stdinJson.model -and $stdinJson.model.display_name) {
    $ModelDisplay = [string]$stdinJson.model.display_name
    $parenIdx = $ModelDisplay.IndexOf(" (")
    if ($parenIdx -ge 0) { $ModelDisplay = $ModelDisplay.Substring(0, $parenIdx) }
    if ($ModelDisplay.StartsWith("Claude ")) { $ModelDisplay = $ModelDisplay.Substring(7) }
    $ModelDisplay = $ModelDisplay.Trim()
}
if ($ModelDisplay) {
    $mdExisting = [PSCustomObject]@{}
    if (Test-Path $TelemetryFile) {
        try {
            $cur = Get-Content $TelemetryFile -Raw
            if ($cur) { $mdExisting = $cur | ConvertFrom-Json }
        } catch {
            $mdExisting = [PSCustomObject]@{}
        }
    }
    if ($mdExisting.PSObject.Properties.Match('model_display').Count -gt 0) {
        $mdExisting.model_display = $ModelDisplay
    } else {
        $mdExisting | Add-Member -NotePropertyName 'model_display' -NotePropertyValue $ModelDisplay
    }
    try {
        # Distinct temp suffix from the .tmp above: two statusline renders
        # can overlap on a fast typist.
        $mdTmp = "${TelemetryFile}.mdl.tmp"
        $mdExisting | ConvertTo-Json -Compress | Set-Content -Path $mdTmp -NoNewline
        Move-Item -Path $mdTmp -Destination $TelemetryFile -Force
    } catch {}
}

# ── Durable rate-limit snapshot (INV-050) ────────────────────────────
# Mirrors the current turn's seven_day_pct/five_hour_pct + resets_at to
# ~/.tkr/rate-limits.json (survives $TMPDIR sweep, unlike $TelemetryFile
# above) so `tkr usage`/trajectory can compare Anthropic's authoritative
# numbers against the JSONL cap-units scan estimate. Fire-and-forget: a
# detached child process (not awaited) so a slow or failing write never
# blocks or breaks the statusline render. `tkr signals rl-snapshot`
# self-throttles to one disk write per 30s.
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "tkr"
    $psi.Arguments = "signals rl-snapshot"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
} catch {}

# Read brevity mode
$Brevity = ""
if (Test-Path $BrevityFlag) {
    $Brevity = (Get-Content $BrevityFlag -Raw).Trim()
}

# Read pressure + session state
$Pressure = ""
$SessionBadge = ""
$TurnCount = 0
$SavedK = 0
$RouteClass = ""
$RouteEffort = ""
$WorkBadge = ""
$HookBad = $false
$SevenDayResetsLabel = ""
$FiveHourResetsLabel = ""
if (Test-Path $TelemetryFile) {
    try {
        $telemetry = Get-Content $TelemetryFile -Raw | ConvertFrom-Json
        $weekly = [int]($telemetry.seven_day_pct)
        $session = [int]($telemetry.five_hour_pct)
        $pct = [Math]::Max($weekly, $session)
        if ($pct -ge 85) { $Pressure = "CRIT" }
        elseif ($pct -ge 70) { $Pressure = "HIGH" }
        elseif ($pct -ge 50) { $Pressure = "ELEV" }
        $TurnCount = [int]($telemetry.turn_count)
        if ($TurnCount -ge 80)      { $SessionBadge = "LONG!" }
        elseif ($TurnCount -ge 50)  { $SessionBadge = "LONG"  }
        if ($telemetry.tkr_saved_session_k) {
            $SavedK = [int]($telemetry.tkr_saved_session_k)
        }
        # Route verdict is NOT read here any more. It moved out of this
        # shared payload into the per-session route state file
        # (internal/route/state.go) because this payload had two
        # independent read-modify-write owners — `tkr route classify` and
        # `tkr statusline-update` — and whichever wrote second dropped the
        # other's fields. It now arrives via `tkr signals
        # --statusline-fields` below, same as statusline.sh.
        # RTK-004: hook integrity badge. hook_bad=true → HOOK! badge.
        if ($telemetry.hook_bad -eq $true) { $HookBad = $true }
        # INV-048a: resets countdown badges. Gated on the window still
        # being in the future — absent/0/already-passed render nothing.
        $nowEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        if ($telemetry.seven_day_resets_at) {
            $remain = [long]($telemetry.seven_day_resets_at) - $nowEpoch
            if ($remain -gt 0) { $SevenDayResetsLabel = Format-ResetsCountdown $remain }
        }
        if ($telemetry.five_hour_resets_at) {
            $remain = [long]($telemetry.five_hour_resets_at) - $nowEpoch
            if ($remain -gt 0) { $FiveHourResetsLabel = Format-ResetsCountdown $remain }
        }
    } catch {}
}

# ── Stalled-subagent count (INV-049a) ────────────────────────────────
# `tkr signals --statusline-fields` emits TKR_STALLED_SUBAGENTS (INV-049
# detection: subagent transcripts idle >180s with no completion marker).
# 30s file cache mirrors statusline.sh's TKR_SIG_CACHE mechanism so this
# doesn't spawn a second `tkr` process on every render.
$StalledSubagents = 0
# INV-053: cross-session live/busy counts. Parsed from the same cached
# `tkr signals --statusline-fields` lines as StalledSubagents above —
# no extra tkr subprocess spawn.
$OtherLiveSessions = 0
$OtherBusySessions = 0
try {
    $sigCache = Join-Path ([System.IO.Path]::GetTempPath()) "tkr-statusline-signals-ps1.cache"
    $sigFresh = $false
    if (Test-Path $sigCache) {
        $age = (Get-Date) - (Get-Item $sigCache).LastWriteTime
        if ($age.TotalSeconds -ge 0 -and $age.TotalSeconds -le 30) { $sigFresh = $true }
    }
    $sigLines = $null
    if ($sigFresh) {
        $sigLines = Get-Content $sigCache -ErrorAction Stop
    } else {
        $raw = & tkr signals --statusline-fields 2>$null
        if ($raw) {
            $raw | Set-Content -Path $sigCache -ErrorAction SilentlyContinue
            $sigLines = $raw
        }
    }
    if ($sigLines) {
        foreach ($line in $sigLines) {
            if ($line -match '^TKR_STALLED_SUBAGENTS=(\d+)$') {
                $StalledSubagents = [int]$Matches[1]
            } elseif ($line -match '^TKR_OTHER_LIVE_SESSIONS=(\d+)$') {
                $OtherLiveSessions = [int]$Matches[1]
            } elseif ($line -match '^TKR_OTHER_BUSY_SESSIONS=(\d+)$') {
                $OtherBusySessions = [int]$Matches[1]
            } elseif ($line -match '^TKR_ROUTE_CLASS=(.*)$') {
                # String fields are shell-quoted by cmd_signals.shellQuote,
                # so strip the wrapping single quotes. An empty verdict
                # emits '' and must read as empty, not as a two-character
                # value that would render a hollow RT badge.
                $RouteClass = $Matches[1].Trim("'")
            } elseif ($line -match '^TKR_ROUTE_EFFORT=(.*)$') {
                $RouteEffort = $Matches[1].Trim("'")
            } elseif ($line -match '^TKR_WORK_BADGE=(.*)$') {
                # Body only ("HAI", "SON/M"), already composed by
                # route.WorkPlan.Badge. Empty means no native-worker plan
                # for this prompt — including every stay_main verdict.
                $WorkBadge = $Matches[1].Trim("'")
            }
        }
    }
} catch {}

# Build badge
$Badge = "TKR"
$Suffix = ""

if ($Brevity -and $Brevity -ne "full") {
    $Suffix = ":$($Brevity.ToUpper())"
}

if ($Pressure) {
    $Suffix = "${Suffix}|${Pressure}"
}

if ($SessionBadge) {
    $Suffix = "${Suffix}|${SessionBadge}"
}

# INV-053: live-session badge — other concurrent Claude Code sessions on
# this machine (registry-derived, PID-reuse guarded). Display-only.
if ($OtherLiveSessions -gt 0) {
    if ($OtherBusySessions -gt 0) {
        $Suffix = "${Suffix}|S:${OtherLiveSessions}(${OtherBusySessions}busy)"
    } else {
        $Suffix = "${Suffix}|S:${OtherLiveSessions}"
    }
}

# INV-049a: stalled-subagent warning — display-only, never feeds routing.
if ($StalledSubagents -gt 0) {
    $Suffix = "${Suffix}|STALL:${StalledSubagents}"
}

# RTK-004: hook integrity badge — always red, highest severity.
if ($HookBad) {
    $Suffix = "${Suffix}|HOOK!"
}

$badgeColor = "DarkYellow"
if ($HookBad -or $SessionBadge -eq "LONG!" -or $Pressure -eq "CRIT" -or $StalledSubagents -gt 0) { $badgeColor = "Red" }
elseif ($SessionBadge -eq "LONG" -or $Pressure -eq "HIGH") { $badgeColor = "Yellow" }

Write-Host "[${Badge}${Suffix}]" -NoNewline -ForegroundColor $badgeColor

if ($TurnCount -gt 0) {
    Write-Host " t:${TurnCount}" -NoNewline -ForegroundColor DarkGray
}

# INV-048a: resets countdown badges.
if ($SevenDayResetsLabel) {
    Write-Host " rst7d:${SevenDayResetsLabel}" -NoNewline -ForegroundColor DarkGray
}
if ($FiveHourResetsLabel) {
    Write-Host " rst5h:${FiveHourResetsLabel}" -NoNewline -ForegroundColor DarkGray
}

if ($SavedK -gt 0) {
    $savedColor = "DarkGray"
    if ($SavedK -ge 25)    { $savedColor = "Green" }
    elseif ($SavedK -ge 5) { $savedColor = "DarkGreen" }
    Write-Host " SAVED:${SavedK}k" -NoNewline -ForegroundColor $savedColor
}

# Work-route badge (parity with statusline.sh WRK_BADGE). Task economy,
# not capacity — see the note there.
if ($WorkBadge) {
    Write-Host " WRK:${WorkBadge}" -NoNewline -ForegroundColor DarkGray
}

# ADR-0010 route-verdict badge (parity with statusline.sh RT_BADGE; ASCII
# separator to stay safe under Windows PowerShell 5.1 encodings).
if ($RouteEffort) {
    $rtClass = $RouteClass
    if ($rtClass.Length -gt 12) { $rtClass = $rtClass.Substring(0, 12) }
    $rtLabel = if ($rtClass) { "${rtClass}>${RouteEffort}" } else { $RouteEffort }
    Write-Host " RT:${rtLabel}" -NoNewline -ForegroundColor DarkGray
}
