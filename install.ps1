#Requires -Version 5.1
<#
.SYNOPSIS
    tkr installer for Windows — downloads the latest release binary from GitHub.

.DESCRIPTION
    Supports two modes:
      -Cli     CLI-only: installs the tkr binary to PATH (default)
      -Plugin  Full plugin: binary + hooks + skills + scripts + adapters for Claude Code

    Auto-detection: if neither flag is given, checks whether Claude Code is
    installed. If found, uses plugin mode; otherwise installs CLI-only.

.PARAMETER Cli
    Install CLI binary only (no plugin components).

.PARAMETER Plugin
    Install full Claude Code plugin (binary + hooks + skills + scripts + adapters).

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
    [string]$Version = $env:TKR_VERSION,
    [string]$InstallDir = $env:TKR_INSTALL_DIR,
    [string]$PluginDir = $env:TKR_PLUGIN_DIR
)

$ErrorActionPreference = "Stop"

$Repo = "bpeers01/tkr-releases"
$SourceRepo = "bpeers01/tkr"

# --- Detect mode ---

$Mode = ""
if ($Cli) { $Mode = "cli" }
if ($Plugin) { $Mode = "plugin" }

if (-not $Mode) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host "Claude Code detected. Installing in plugin mode (-Cli to skip)."
        $Mode = "plugin"
    } else {
        $Mode = "cli"
    }
}

Write-Host "Install mode: $Mode"

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
        exit 0
    }

    # ======================================================================
    # Plugin mode: install hooks, skills, scripts, adapters for Claude Code
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
    } else {
        # Download plugin bundle from release
        $BundleUrl = "$BaseUrl/tkr-plugin.tar.gz"
        $BundlePath = Join-Path $TempDir "tkr-plugin.tar.gz"

        Write-Host "Downloading plugin bundle..."
        try {
            Invoke-WebRequest -Uri $BundleUrl -OutFile $BundlePath -UseBasicParsing
        } catch {
            Write-Error "Failed to download plugin bundle from $BundleUrl`nThe plugin bundle may not be available for this release.`nUse -Cli for binary-only install, or clone the repo and run .\install.ps1 -Plugin"
            exit 1
        }

        # Verify plugin bundle checksum
        $BundleExpectedLine = Get-Content $ChecksumPath | Where-Object { $_ -match "tkr-plugin.tar.gz" }
        if ($BundleExpectedLine) {
            $BundleExpected = ($BundleExpectedLine -split '\s+')[0]
            $BundleActual = (Get-FileHash -Path $BundlePath -Algorithm SHA256).Hash.ToLower()
            if ($BundleActual -ne $BundleExpected) {
                Write-Error "Plugin bundle checksum mismatch`n  expected: $BundleExpected`n  got:      $BundleActual"
                exit 1
            }
            Write-Host "Plugin bundle checksum verified."
        }

        # Extract to plugin dir
        New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
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
                    Remove-Item $LegacyPath -Force
                    Write-Host "  Removed legacy hook file: $LegacyFile"
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
                    $PluginStatusLineCmd = "bash $($PluginDir -replace '\\', '/')/hooks/statusline.sh"
                    $CurrentSL = if ($Settings.PSObject.Properties.Name -contains "statusLine") { $Settings.statusLine } else { "" }
                    if ($CurrentSL -eq "" -or $CurrentSL -match "shadowlane") {
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

    # --- Done ---

    Write-Host ""
    Write-Host "tkr plugin installed successfully."
    Write-Host "  Binary:  $Dest"
    Write-Host "  Plugin:  $PluginDir"
    Write-Host "  State:   $TkrStateDir"
    Write-Host ""
    Write-Host "Available skills: /tkr-search, /tkr-delegate, /tkr-brevity, /tkr-compress, /tkr-status, /tkr-config"
    Write-Host "MCP tool:         delegate (from any Claude Code session - see docs/delegate-usage.md)"
    Write-Host ""
    Write-Host "Set up shell hook (optional, for terminal use):"
    Write-Host "  tkr init -g"

} finally {
    # Cleanup temp dir
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
