#Requires -Version 5.1
<#
.SYNOPSIS
    tkr installer for Windows — downloads the latest release binary from GitHub.

.DESCRIPTION
    Supports three modes (PUBLIC-009 core/advanced split):
      -Cli             CLI-only: installs the tkr binary to PATH (default)
      -Plugin          Core plugin: binary + hooks + 9 core skills
      -PluginAdvanced  Everything: core plus 13 advanced skills (delegation,
                       OpenRouter toggles, audits), the deprecated shell
                       delegation cascade (ADR-0023) and adapters

    Auto-detection: if no flag is given, checks whether Claude Code is
    installed. If found, uses core plugin mode; otherwise installs CLI-only.

.PARAMETER Cli
    Install CLI binary only (no plugin components).

.PARAMETER Plugin
    Install the core Claude Code plugin (binary + hooks + core skills).

.PARAMETER PluginAdvanced
    Install the full Claude Code plugin (core plus advanced skills,
    delegation scripts, and adapters).

.PARAMETER Version
    Pin a specific version tag (e.g., "v1.12.1"). Default: latest release.

.PARAMETER InstallDir
    Override binary install directory. Default: $env:LOCALAPPDATA\tkr\bin

.PARAMETER PluginDir
    Override plugin install directory. Default: $env:LOCALAPPDATA\tkr\plugin

.EXAMPLE
    irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.ps1 | iex
    .\install.ps1 -Plugin
    .\install.ps1 -Cli -Version v1.12.1
#>

param(
    [switch]$Cli,
    [switch]$Plugin,
    [switch]$PluginAdvanced,
    [string]$Version = $env:TKR_VERSION,
    [string]$InstallDir = $env:TKR_INSTALL_DIR,
    [string]$PluginDir = $env:TKR_PLUGIN_DIR
)

$ErrorActionPreference = "Stop"

$Repo = "bpeers01/tkr-releases"
$SourceRepo = "bpeers01/tkr"

# --- Detect mode ---

$Mode = ""
$Tier = "core"
if ($Cli) { $Mode = "cli" }
if ($Plugin) { $Mode = "plugin"; $Tier = "core" }
if ($PluginAdvanced) { $Mode = "plugin"; $Tier = "advanced" }

if (-not $Mode) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host "Claude Code detected. Installing core plugin (-Cli to skip, -PluginAdvanced for everything)."
        $Mode = "plugin"
    } else {
        $Mode = "cli"
    }
}

if ($Mode -eq "plugin") {
    Write-Host "Install mode: plugin ($Tier tier)"
} else {
    Write-Host "Install mode: $Mode"
}

# --- Detect architecture ---

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($Arch -ne [System.Runtime.InteropServices.Architecture]::X64) {
    Write-Error "Windows builds are only available for x64 (detected: $Arch)"
    exit 1
}

$Artifact = "tkr-windows-amd64.exe"

# --- Resolve version ---

if (-not $Version) {
    Write-Host "Fetching latest release..."
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Tag = $Release.tag_name
    if (-not $Tag) {
        Write-Error "Could not determine latest release"
        exit 1
    }
} else {
    $Tag = $Version
}

Write-Host "Installing tkr $Tag (windows/amd64)..."

# --- Download ---

$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$TempDir = Join-Path $env:TEMP "tkr-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $ArtifactPath = Join-Path $TempDir $Artifact
    $ChecksumPath = Join-Path $TempDir "checksums.sha256"

    Write-Host "Downloading $Artifact..."
    Invoke-WebRequest -Uri "$BaseUrl/$Artifact" -OutFile $ArtifactPath -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/checksums.sha256" -OutFile $ChecksumPath -UseBasicParsing

    # --- Verify SHA256 checksum ---

    $ExpectedLine = Get-Content $ChecksumPath | Where-Object { $_ -match $Artifact }
    if (-not $ExpectedLine) {
        Write-Error "No checksum found for $Artifact in checksums.sha256"
        exit 1
    }
    $Expected = ($ExpectedLine -split '\s+')[0]

    $ActualHash = (Get-FileHash -Path $ArtifactPath -Algorithm SHA256).Hash.ToLower()
    if ($ActualHash -ne $Expected) {
        Write-Error "Checksum mismatch`n  expected: $Expected`n  got:      $ActualHash"
        exit 1
    }
    Write-Host "Checksum verified."

    # --- Install binary ---

    if (-not $InstallDir) {
        $InstallDir = Join-Path $env:LOCALAPPDATA "tkr\bin"
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    $Dest = Join-Path $InstallDir "tkr.exe"
    $DestOld = "$Dest.old"

    # Rename-before-copy: if a previous binary exists, rename it aside first.
    # A plain Move-Item -Force silently fails when tkr.exe is locked (e.g. a
    # running process holds the file open), leaving the stale binary in place
    # with no error. The rename detects the lock and gives a clear error message.
    if (Test-Path $Dest) {
        if (Test-Path $DestOld) { Remove-Item $DestOld -Force -ErrorAction SilentlyContinue }
        try {
            Rename-Item -Path $Dest -NewName "$($Dest).old" -ErrorAction Stop
        } catch {
            Write-Error "tkr.exe is locked (another process is using it).`nClose all tkr processes and retry.`nDetails: $_"
            exit 1
        }
    }

    try {
        Move-Item -Path $ArtifactPath -Destination $Dest -ErrorAction Stop
    } catch {
        # Restore old binary so the system is not left without tkr.
        if (Test-Path $DestOld) {
            Rename-Item -Path $DestOld -NewName $Dest -ErrorAction SilentlyContinue
        }
        Write-Error "Failed to install tkr.exe: $_"
        exit 1
    }

    if (Test-Path $DestOld) { Remove-Item $DestOld -Force -ErrorAction SilentlyContinue }
    Write-Host "Installed tkr to $Dest"

    # Verify the installed binary reports the expected version.
    try {
        $VersionOutput = & $Dest --version 2>$null
        $InstalledVersion = ($VersionOutput -replace '^tkr\s+', '').Trim()
        if ($InstalledVersion -eq $Tag) {
            Write-Host "Version verified: $VersionOutput"
        } else {
            Write-Warning "Version mismatch: expected $Tag, got '$InstalledVersion'`nRestart your terminal and re-run the installer if the mismatch persists."
        }
    } catch {
        Write-Warning "Could not verify installed version: $_"
    }

    # --- PATH check ---

    $UserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        Write-Host ""
        Write-Host "Adding $InstallDir to user PATH..."
        [System.Environment]::SetEnvironmentVariable("PATH", "$InstallDir;$UserPath", "User")
        $env:PATH = "$InstallDir;$env:PATH"
        Write-Host "PATH updated. Restart your terminal for changes to take effect."
    }

    # --- Register tkr mcp server with Claude Code ---
    #
    # `tkr mcp` exposes the `delegate` tool over stdio. Registering here means
    # a fresh install can immediately call delegate(...) from a Claude Code
    # session. Idempotent: remove-then-add. Never fails the install on MCP
    # wiring errors — the binary is the load-bearing artifact, MCP is opt-in.

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host ""
        Write-Host "Registering tkr mcp server with Claude Code..."
        & claude mcp remove tkr 2>$null | Out-Null
        try {
            & claude mcp add tkr -- $Dest mcp 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  tkr mcp server registered (calls delegate(...) from any session)."
            } else {
                throw "claude mcp add exited with code $LASTEXITCODE"
            }
        } catch {
            Write-Host "  Note: 'claude mcp add tkr' failed - register manually with:" -ForegroundColor Yellow
            Write-Host "    claude mcp add tkr -- `"$Dest`" mcp" -ForegroundColor Yellow
        }
    }

    # --- CLI-only: done ---

    if ($Mode -eq "cli") {
        Write-Host ""
        Write-Host "Set up Claude Code integration:"
        Write-Host "  tkr init -g"
        Write-Host ""
        Write-Host "Verifying install..."
        try { & $Dest doctor } catch { }
        Write-Host ""
        Write-Host "Re-run anytime with: tkr doctor"
        exit 0
    }

    # ======================================================================
    # Plugin mode: install hooks + skills for Claude Code (core tier), plus
    # scripts/adapters/advanced skills when -PluginAdvanced (PUBLIC-009)
    # ======================================================================

    Write-Host ""
    Write-Host "Installing plugin components..."

    if (-not $PluginDir) {
        $PluginDir = Join-Path $env:LOCALAPPDATA "tkr\plugin"
    }

    # Detect if running from a local repo clone (.\install.ps1).
    # When piped via irm|iex, $MyInvocation path won't point to a repo.
    $ScriptSource = ""
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
    if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir ".claude-plugin\plugin.json"))) {
        $ScriptSource = $ScriptDir
    }

    if ($ScriptSource) {
        Write-Host "Source: local clone at $ScriptSource"
        $PluginDir = $ScriptSource
        if ($Tier -eq "advanced") {
            # Enable advanced skills by copying them into the registered
            # skills/ dir (Claude Code only loads skills/ — PUBLIC-008).
            # Adds untracked copies to the clone; git clean -fd skills/ reverts.
            $AdvSkills = Join-Path $PluginDir "skills-advanced"
            if (Test-Path $AdvSkills) {
                Copy-Item -Path (Join-Path $AdvSkills "*") -Destination (Join-Path $PluginDir "skills") -Recurse -Force
                Write-Host "Advanced skills enabled (copied skills-advanced\* into skills\ - untracked in the clone)."
            }
        } else {
            # Core tier on a dev clone: nothing is deleted from the working
            # tree (ADR-0023 quarantined files stay but are unreferenced).
            # Warn if a previous advanced enable left copies registered.
            $AdvSkills = Join-Path $PluginDir "skills-advanced"
            if (Test-Path $AdvSkills) {
                $Leftover = Get-ChildItem $AdvSkills -Directory | Where-Object {
                    Test-Path (Join-Path $PluginDir "skills\$($_.Name)")
                } | ForEach-Object { $_.Name }
                if ($Leftover) {
                    Write-Host "Warning: advanced skills from a previous -PluginAdvanced install remain registered: $($Leftover -join ', ')" -ForegroundColor Yellow
                    Write-Host "  Remove them from skills\ (git clean -fd skills/) to run a pure core tier." -ForegroundColor Yellow
                }
            }
        }
    } else {
        # Download the tier's plugin bundle from the release. Core:
        # tkr-plugin.tar.gz (.claude-plugin + hooks + core skills only —
        # scripts\delegate.sh and adapters\ excluded per ADR-0023).
        # Advanced: tkr-plugin-advanced.tar.gz (everything, advanced
        # skills pre-merged into skills\).
        $BundleFile = "tkr-plugin.tar.gz"
        if ($Tier -eq "advanced") { $BundleFile = "tkr-plugin-advanced.tar.gz" }
        $BundleUrl = "$BaseUrl/$BundleFile"
        $BundlePath = Join-Path $TempDir $BundleFile

        Write-Host "Downloading plugin bundle ($Tier)..."
        try {
            Invoke-WebRequest -Uri $BundleUrl -OutFile $BundlePath -UseBasicParsing
        } catch {
            $AdvNote = if ($Tier -eq "advanced") { "`n(Releases before the core/advanced split only ship tkr-plugin.tar.gz.)" } else { "" }
            Write-Error "Failed to download plugin bundle from $BundleUrl`nThe plugin bundle may not be available for this release.$AdvNote`nUse -Cli for binary-only install, or clone the repo and run .\install.ps1 -Plugin"
            exit 1
        }

        # Verify plugin bundle checksum. Hard-fail on a missing entry — mirror
        # the binary path so an unverified bundle (session-executing hooks and
        # scripts) is never extracted (REV-S3).
        $BundleExpectedLine = Get-Content $ChecksumPath | Where-Object { $_ -match [regex]::Escape($BundleFile) }
        if (-not $BundleExpectedLine) {
            Write-Error "No checksum found for $BundleFile in checksums.sha256"
            exit 1
        }
        $BundleExpected = ($BundleExpectedLine -split '\s+')[0]
        $BundleActual = (Get-FileHash -Path $BundlePath -Algorithm SHA256).Hash.ToLower()
        if ($BundleActual -ne $BundleExpected) {
            Write-Error "Plugin bundle checksum mismatch`n  expected: $BundleExpected`n  got:      $BundleActual"
            exit 1
        }
        Write-Host "Plugin bundle checksum verified."

        # Extract to plugin dir. Remove bundle-owned payload dirs first so
        # a reinstall or tier switch (advanced -> core) is authoritative —
        # stale advanced skills/scripts/adapters must not survive.
        New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
        foreach ($d in @(".claude-plugin", "agents", "hooks", "skills", "skills-advanced", "scripts", "adapters")) {
            $p = Join-Path $PluginDir $d
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
        tar xzf $BundlePath -C $PluginDir
        Write-Host "Plugin files extracted to $PluginDir"
    }

    # --- Register with Claude Code ---

    Write-Host "Registering plugin with Claude Code..."

    $Registered = $false
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        try {
            claude plugin marketplace add $PluginDir 2>$null
            claude plugin install tkr 2>$null
            Write-Host "Plugin registered: tkr@tkr (marketplace + install)."
            $Registered = $true

            # INST-001: clean up legacy hook files and settings.json entries left by
            # pre-plugin installs (tkr init -g, manual fallback). Only runs after
            # successful marketplace registration; idempotent if artifacts are absent.
            Write-Host "Cleaning up legacy hooks..."
            $ClaudeHooksDir = Join-Path $env:USERPROFILE ".claude\hooks"
            $LegacyFiles = @("tkr-rewrite.sh", "session-start.js", "user-prompt-submit.js", "statusline.sh", "statusline.ps1")
            foreach ($LegacyFile in $LegacyFiles) {
                $LegacyPath = Join-Path $ClaudeHooksDir $LegacyFile
                if (Test-Path $LegacyPath) {
                    # Ownership check: these names are generic and the hooks dir is
                    # shared — only delete files that carry a tkr marker; a
                    # same-named file without one is user-owned, leave it.
                    if (Select-String -Path $LegacyPath -Pattern "tkr" -Quiet) {
                        Remove-Item $LegacyPath -Force
                        Write-Host "  Removed legacy hook file: $LegacyFile"
                    } else {
                        Write-Host "  Skipped $LegacyPath — no tkr marker; looks user-owned, leaving in place."
                    }
                }
            }

            $SettingsFile = Join-Path $env:USERPROFILE ".claude\settings.json"
            if (Test-Path $SettingsFile) {
                try {
                    $Settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
                    $SettingsChanged = $false

                    # Remove tkr-rewrite PreToolUse hooks (added by tkr init -g / manual install).
                    # Two formats exist: flat (.command at top) and matcher (.hooks[].command nested).
                    if ($Settings.hooks -and $Settings.hooks.PreToolUse) {
                        $Before = @($Settings.hooks.PreToolUse).Count
                        $Settings.hooks.PreToolUse = @($Settings.hooks.PreToolUse | Where-Object {
                            $entry = $_
                            $isTkr = $false
                            # Flat format: {"type":"command","command":"...tkr-rewrite..."}
                            if ($entry.command -match "tkr-rewrite") { $isTkr = $true }
                            # Matcher format: {"matcher":"...","hooks":[{"command":"...tkr-rewrite..."}]}
                            if ($entry.hooks) {
                                foreach ($h in @($entry.hooks)) {
                                    if ($h.command -match "tkr-rewrite") { $isTkr = $true }
                                }
                            }
                            -not $isTkr
                        })
                        if (@($Settings.hooks.PreToolUse).Count -lt $Before) {
                            Write-Host "  Removed legacy tkr-rewrite PreToolUse hook from settings.json"
                            $SettingsChanged = $true
                        }
                    }

                    # Replace old Shadowlane statusLine with the plugin's own statusline,
                    # or add it if absent — so the badge activates automatically on plugin install.
                    # Prefer the fork-free native verb when the installed binary supports it
                    # (INV-085); fall back to the bash script for a binary that predates it.
                    $PluginStatusLineCmd = "bash $($PluginDir -replace '\\', '/')/hooks/statusline.sh"
                    # Values this installer may overwrite. Never widen this to match a
                    # statusLine the user chose themselves — leave unrecognized values alone.
                    $LegacyStatusLineRe = "shadowlane"
                    try {
                        & $Dest statusline render --help *> $null
                        if ($LASTEXITCODE -eq 0) {
                            $PluginStatusLineCmd = "`"$Dest`" statusline render"
                            # INST-007: see install.sh — an existing install already points at
                            # tkr's own forking bash renderer, matching neither clause, so it
                            # never upgraded. Adopt it only when the binary serves the verb.
                            $LegacyStatusLineRe = "shadowlane|hooks[/\\]statusline\.(sh|ps1)"
                        }
                    } catch {
                        # $Dest predates the verb or invocation failed — keep the bash fallback.
                    }
                    # INST-004 parity: .statusLine may be an object, not a string — match on
                    # the .command field in that case rather than the stringified object.
                    $CurrentSLRaw = if ($Settings.PSObject.Properties.Name -contains "statusLine") { $Settings.statusLine } else { "" }
                    $CurrentSL = if ($CurrentSLRaw -is [string]) {
                        $CurrentSLRaw
                    } elseif ($null -ne $CurrentSLRaw -and $CurrentSLRaw.PSObject.Properties.Name -contains "command") {
                        [string]$CurrentSLRaw.command
                    } else {
                        ""
                    }
                    if ($CurrentSL -eq "" -or $CurrentSL -match $LegacyStatusLineRe) {
                        $Settings | Add-Member -NotePropertyName "statusLine" -NotePropertyValue $PluginStatusLineCmd -Force
                        Write-Host "  Set tkr statusLine in settings.json"
                        $SettingsChanged = $true
                    }

                    if ($SettingsChanged) {
                        $Settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
                        Write-Host "Legacy settings cleanup complete."
                    }
                } catch {
                    Write-Host "  Note: could not parse settings.json — skipping legacy settings cleanup." -ForegroundColor Yellow
                }
            }
        } catch {
            Write-Host "Note: marketplace registration failed - falling back to manual hook wiring." -ForegroundColor Yellow
        }
    }

    if (-not $Registered) {
        $ClaudeHooksDir = Join-Path $env:USERPROFILE ".claude\hooks"
        New-Item -ItemType Directory -Path $ClaudeHooksDir -Force | Out-Null

        # Copy hook scripts
        Get-ChildItem (Join-Path $PluginDir "hooks") -File | ForEach-Object {
            Copy-Item $_.FullName -Destination $ClaudeHooksDir -Force
        }
        Write-Host "Hooks copied to $ClaudeHooksDir"

        $SettingsFile = Join-Path $env:USERPROFILE ".claude\settings.json"
        Write-Host ""
        Write-Host "To complete setup, add hooks to $SettingsFile :"
        Write-Host '  "hooks": {'
        Write-Host "    `"PreToolUse`": [{ `"type`": `"command`", `"command`": `"node $ClaudeHooksDir/tkr-rewrite.js`" }],"
        Write-Host "    `"SessionStart`": [{ `"type`": `"command`", `"command`": `"node $ClaudeHooksDir/session-start.js`" }],"
        Write-Host "    `"UserPromptSubmit`": [{ `"type`": `"command`", `"command`": `"node $ClaudeHooksDir/user-prompt-submit.js`" }]"
        Write-Host '  }'
    }

    # --- Create runtime state directory ---

    $TkrStateDir = Join-Path $env:USERPROFILE ".tkr"
    New-Item -ItemType Directory -Path $TkrStateDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $TkrStateDir "contracts") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $TkrStateDir "delegations") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $TkrStateDir "validation") -Force | Out-Null
    Write-Host "Runtime state directory: $TkrStateDir"

    # Record the installed tier so `tkr status` can report it (PUBLIC-009).
    Set-Content -Path (Join-Path $TkrStateDir "plugin-tier") -Value $Tier -Encoding ascii
    Write-Host "Plugin tier recorded: $Tier (shown by 'tkr status')"

    # --- Done ---

    Write-Host ""
    Write-Host "tkr plugin installed successfully ($Tier tier)."
    Write-Host "  Binary:  $Dest"
    Write-Host "  Plugin:  $PluginDir"
    Write-Host "  State:   $TkrStateDir"
    Write-Host ""
    Write-Host "Available skills: /tkr-search, /brevity, /tkr-compress, /tkr-status, /tkr-usage, /tkr-config, /continue, /handoff"
    if ($Tier -eq "advanced") {
        Write-Host "Advanced skills:  enabled (/delegate, /openrouter-on|off, audits, /memory-compact, ...)"
        Write-Host "Note:             scripts/delegate.sh (shell cascade) is DEPRECATED - ADR-0023; the delegate MCP tool is the supported path"
    } else {
        Write-Host "Advanced tier:    re-run the installer with -PluginAdvanced to add delegation, OpenRouter toggles, and the audit skills"
    }
    Write-Host "MCP tool:         delegate (from any Claude Code session - see docs/delegate-usage.md)"
    Write-Host "                  tkr_graph (structural code intel - who calls X, what breaks if I change Y)"
    Write-Host ""
    Write-Host "Set up shell hook (optional, for terminal use):"
    Write-Host "  tkr init -g"
    Write-Host ""

    # POSIX sh check (Windows-only): tkr graph install-hooks ships a sh-based
    # hook that silently no-ops under native cmd.exe git. Surface the hint so
    # users on native git install Git for Windows / msys2 / WSL before they
    # first hit `tkr_graph` (which auto-installs the hooks).
    $hasShell = (Get-Command sh -ErrorAction SilentlyContinue) -or
                (Get-Command bash -ErrorAction SilentlyContinue)
    if (-not $hasShell) {
        Write-Host "Heads up: native Windows git detected (no sh/bash on PATH)." -ForegroundColor Yellow
        Write-Host "  tkr's graph hooks need Git for Windows / msys2 / WSL to fire on branch swaps." -ForegroundColor Yellow
        Write-Host "  Without one of those, set TKR_GRAPH_FORCE_HOOKS=1 to install hooks anyway" -ForegroundColor Yellow
        Write-Host "  (the 24h staleness fallback still keeps the graph correct, just slower)." -ForegroundColor Yellow
        Write-Host ""
    }

    Write-Host "Verifying install..."
    try { & $Dest doctor } catch { }
    Write-Host ""
    Write-Host "Re-run anytime with: tkr doctor"

} finally {
    # Cleanup temp dir
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
