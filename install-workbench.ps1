#Requires -Version 5.1
<#
.SYNOPSIS
    tkr-workbench installer for Windows - downloads the latest workbench
    release from GitHub and installs it as a standalone GUI app.

.DESCRIPTION
    tkr-workbench ships from the same public repo as the tkr CLI
    (bpeers01/tkr-releases) but under its OWN tag namespace: tags look
    like "workbench-v1.2.0", separate from the CLI's "v*" tags. Because
    of that, this installer does NOT use the /releases/latest endpoint -
    that endpoint returns the newest release across ALL tags in the repo
    and would hand back a CLI release instead of a workbench one. Version
    resolution instead lists all releases and filters to tag_name values
    that start with "workbench-v".

    Install layout: $env:LOCALAPPDATA\Programs\tkr-workbench\tkr-workbench.exe
    plus a conpty\ subdirectory beside it. internal/workbench/pty looks for
    exactly <exe dir>\conpty and silently falls back to the host's inbox
    ConPTY without it, so conpty\ MUST end up beside the exe - this
    installer extracts the release zip as a directory-level swap so both
    the exe and the conpty\ files move together.

    The program directory is deliberately NOT $env:LOCALAPPDATA\tkr\workbench.
    That path is the RUNTIME DATA directory - internal/workbench/paths
    resolves it there, and sessions.json, projects.json, runtime.token and
    scrollback\*.bin all live in it. Installing over it would destroy a
    user's session state, because the swap below renames the existing target
    aside and then deletes it; -Uninstall would take the session history with
    it too. The guard below refuses that target however it is supplied.

    The release binary is not code-signed, so Windows SmartScreen will
    show an "unrecognized app" warning on first launch. This installer
    prints a short note about that; it does not attempt to bypass it.

.PARAMETER Version
    Pin a specific workbench version tag (e.g. "workbench-v1.2.0" or
    "1.2.0" - either form is accepted). Default: $env:TKR_WORKBENCH_VERSION,
    or the newest "workbench-v*" release if neither is set.

.PARAMETER InstallDir
    Override the install directory. Default:
    $env:LOCALAPPDATA\Programs\tkr-workbench. It must not be the runtime data
    directory - see the note above; the script refuses that target.

.PARAMETER Uninstall
    Remove the installed app, its Start Menu shortcut, and its
    Add/Remove Programs entry. Does not touch the tkr CLI install.

.PARAMETER Force
    Skip the live-session confirmation prompt below and proceed anyway.
    Required for any non-interactive run (piped `irm | iex` with no
    console attached, a CI job, a scheduled task) that must complete
    while sessions are running - without it, a non-interactive host with
    live sessions refuses instead of hanging on a prompt it can't show.
    `irm | iex` cannot pass switches, so set $env:TKR_WORKBENCH_FORCE = "1"
    there instead.

.DESCRIPTION (continued)
    Both the upgrade swap below and -Uninstall end up replacing or
    removing whatever tkr-workbench runtime process currently owns
    $InstallDir. That runtime holds every managed session's process tree
    in a Windows Job Object with KILL_ON_JOB_CLOSE
    (internal/workbench/runtime/registry.go), so a session that is
    "starting" or "running" in the runtime's sessions.json dies the
    moment that process goes away - silently, with no chance to save
    anything, because the child processes (claude, etc.) are killed with
    the job. Before doing anything destructive, this script reads
    sessions.json in the runtime data directory, checks which of those
    rows still have their recorded session process alive, and
    if any are, warns and asks for confirmation (default: no). A stale
    sessions.json left behind by a crash does not trigger this - only a
    row whose recorded PID is still actually running counts as live.

.EXAMPLE
    irm https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install-workbench.ps1 | iex
    .\install-workbench.ps1 -Version 1.2.0
    .\install-workbench.ps1 -Uninstall
    .\install-workbench.ps1 -Force
#>

param(
    [string]$Version = $env:TKR_WORKBENCH_VERSION,
    [string]$InstallDir = $env:TKR_WORKBENCH_INSTALL_DIR,
    [switch]$Uninstall,
    [switch]$Force = ($env:TKR_WORKBENCH_FORCE -eq "1")
)

$ErrorActionPreference = "Stop"

$Repo = "bpeers01/tkr-releases"
$AppName = "tkr-workbench"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\tkr-workbench"

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\tkr-workbench"
}

# Refuse to install into the runtime data directory. Both the install swap
# and -Uninstall delete $InstallDir wholesale, so aiming it at the data dir
# silently destroys sessions.json, projects.json, runtime.token and every
# scrollback buffer. Still reachable via -InstallDir or
# TKR_WORKBENCH_INSTALL_DIR, so this is not redundant with the default above.
# Mirrors internal/workbench/paths resolution order: TKR_WB_DATA_DIR wins,
# then %LOCALAPPDATA%\tkr\workbench. Checking only the default would leave a
# relocated data dir unprotected.
$DataDir = $env:TKR_WB_DATA_DIR
if (-not $DataDir -and $env:LOCALAPPDATA) {
    $DataDir = Join-Path $env:LOCALAPPDATA "tkr\workbench"
}
if ($DataDir) {
    $ResolvedInstall = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $ResolvedData = [System.IO.Path]::GetFullPath($DataDir).TrimEnd('\')
    if ($ResolvedInstall -ieq $ResolvedData) {
        Write-Error ("InstallDir must not be the workbench runtime data directory ($ResolvedData). " +
            "Installing there would delete your sessions, projects and scrollback. Choose another directory.")
        exit 1
    }
}

$ExePath = Join-Path $InstallDir "tkr-workbench.exe"
$ShortcutPath = Join-Path ([System.Environment]::GetFolderPath("StartMenu")) "Programs\tkr-workbench.lnk"

# --- Live-session detection ---------------------------------------------
#
# sessions.json is the runtime's registry (internal/workbench/runtime/registry.go
# persistedRow / proto.ManagedSession, registry.go:35-49). Fields read
# here, with the Go struct tag as the source of truth for the name:
#   state (registry.go:145-148 / proto/session.go:136-149) - one of the
#     four string values "starting"/"running"/"exited"/"ended".
#   pid (proto/session.go:180: `json:"pid"`) - 0 while StateStarting ("No
#     PID yet"), the root process of the session's Job Object once set.
#   pid_start_ms (registry.go:41: `json:"pid_start_ms"`) - epoch ms
#     creation time of that PID, persisted precisely so a *different*
#     process that later inherits the same PID number is not mistaken
#     for the session's own runtime (registry.go:37-40: "PIDs are
#     recycled; a row whose PID is alive but whose creation time differs
#     is a DIFFERENT process"). May be 0/absent for a row written before
#     a PID existed.
#   title, task, worktree, project_root - proto/session.go:164-196,
#     display-only fields used for the warning below.
#
# A row is live only when its state is starting/running AND the OS
# confirms its recorded pid is currently running. Checking state alone
# would false-positive on a sessions.json left behind by a crash: the
# Go restart rule (applyRestartRule, registry.go:139-165) only rewrites
# a surviving row to "ended" the NEXT time that runtime starts, which
# this script has no way to know has happened. Where pid_start_ms is
# available this also cross-checks the live PID's own creation time
# against it, for the same recycled-PID reason registry.go tracks that
# field - a bare "is this PID alive" is not enough on Windows.
function Get-LiveWorkbenchSessions {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path $Path)) { return @() }

    try {
        $Registry = Get-Content -Path $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        # Malformed sessions.json. A file this script can't parse is not
        # evidence of a live session - do not block on it.
        return @()
    }

    if (-not $Registry -or -not $Registry.sessions) { return @() }

    $Live = @()
    foreach ($Session in @($Registry.sessions)) {
        if ($Session.state -ne "starting" -and $Session.state -ne "running") { continue }
        if (-not $Session.pid -or [int]$Session.pid -le 0) { continue }

        $Proc = Get-Process -Id ([int]$Session.pid) -ErrorAction SilentlyContinue
        if (-not $Proc) { continue }

        if ($Session.pid_start_ms -and [int64]$Session.pid_start_ms -gt 0) {
            try {
                $ActualStartMS = [long]([DateTimeOffset]$Proc.StartTime).ToUnixTimeMilliseconds()
            } catch {
                # Access denied reading StartTime (rare, e.g. a protected
                # process) - can't confirm identity, so don't claim it.
                continue
            }
            if ($ActualStartMS -ne [int64]$Session.pid_start_ms) {
                # Same PID number, different process - the recycled-pid
                # case registry.go's comment describes. Not live.
                continue
            }
        }

        $Live += [PSCustomObject]@{
            Title       = $Session.title
            Task        = $Session.task
            Worktree    = $Session.worktree
            ProjectRoot = $Session.project_root
            Pid         = [int]$Session.pid
            State       = $Session.state
        }
    }
    # Deliberately NOT `return , $Live` (the usual don't-unroll-a-single-
    # element-array idiom): every call site below wraps this call in
    # @(...) itself, and combining both would double-wrap - a single
    # pipeline object (the whole $Live array, however many or few
    # elements) would come through @()'s collection as a length-1 outer
    # array whose one element is $Live, so .Count reads 1 on every
    # non-early-return path even when $Live is empty. Plain unrolling
    # here plus @() at the call site is the correct pairing.
    return $Live
}

# True when Read-Host can actually prompt someone: a piped `irm | iex`
# with no console attached (or a CI/scheduled-task run) has stdin
# redirected and nobody to answer, so Read-Host would either throw or
# hang depending on host - neither of which this script should risk.
function Test-IsInteractiveHost {
    return ([Environment]::UserInteractive) -and (-not [Console]::IsInputRedirected)
}

$DataDirForSessions = if ($ResolvedData) { $ResolvedData } else { $DataDir }
if ($DataDirForSessions) {
    $SessionsFile = Join-Path $DataDirForSessions "sessions.json"
    $LiveSessions = @(Get-LiveWorkbenchSessions -Path $SessionsFile)
    if ($LiveSessions.Count -gt 0) {
        Write-Warning "$($LiveSessions.Count) tkr-workbench session(s) are currently running:"
        foreach ($Session in $LiveSessions) {
            $Label = if ($Session.Title) { $Session.Title } elseif ($Session.Task) { $Session.Task } else { "(untitled session)" }
            $Where = if ($Session.Worktree) { $Session.Worktree } elseif ($Session.ProjectRoot) { $Session.ProjectRoot } else { $null }
            if ($Where) {
                Write-Host "  - $Label  [$Where]"
            } else {
                Write-Host "  - $Label"
            }
        }
        Write-Host ""
        Write-Host "Continuing will replace the running tkr-workbench runtime, which ENDS" -ForegroundColor Yellow
        Write-Host "these sessions and every process they hold (claude, etc.). Any turn in" -ForegroundColor Yellow
        Write-Host "progress is lost; saved conversations can be resumed afterwards with" -ForegroundColor Yellow
        Write-Host "'claude --continue' or 'claude --resume' in the affected worktree." -ForegroundColor Yellow
        Write-Host ""

        if ($Force) {
            Write-Host "-Force given: continuing without confirmation."
        } elseif (-not (Test-IsInteractiveHost)) {
            Write-Error ("Refusing to continue non-interactively with live tkr-workbench sessions running. " +
                "Re-run with -Force (or TKR_WORKBENCH_FORCE=1) to proceed anyway, or close the running sessions first.")
            exit 1
        } else {
            $Answer = Read-Host "Continue and end these sessions? [y/N]"
            if ($Answer -notmatch '^[Yy]') {
                Write-Host "Aborted. No changes made."
                # return, not exit: under `irm | iex` exit closes the user's shell.
                return
            }
        }
    }
}

# SHA-256 without Get-FileHash. A side-by-side PowerShell 7 install puts its
# own module directories ahead of Windows PowerShell's in PSModulePath, so 5.1
# resolves Microsoft.PowerShell.Utility to the 7.x copy, which does not surface
# Get-FileHash into a 5.1 session - and an explicit Import-Module does not fix
# it. Observed on a developer box where every other Utility cmdlet this script
# needs (Invoke-WebRequest, Invoke-RestMethod, ConvertFrom-Json) still resolved
# normally, so the break is narrow and reads like a corrupt Windows install
# rather than what it is. With $ErrorActionPreference = "Stop" this aborted the
# whole install at the verification step.
#
# The .NET API has no module dependency and behaves identically on 5.1 and 7.
function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $bytes = $sha.ComputeHash($stream)
        }
        finally {
            $stream.Close()
        }
    }
    finally {
        $sha.Dispose()
    }
    return (-join ($bytes | ForEach-Object { $_.ToString("x2") }))
}

# --- Uninstall path -----------------------------------------------------

if ($Uninstall) {
    Write-Host "Uninstalling tkr-workbench..."

    if (Test-Path $InstallDir) {
        try {
            Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction Stop
            Write-Host "  Removed $InstallDir"
        } catch {
            Write-Error "Could not remove $InstallDir - close tkr-workbench and retry.`nDetails: $_"
            exit 1
        }
    } else {
        Write-Host "  $InstallDir not found (already removed)."
    }

    if (Test-Path $ShortcutPath) {
        Remove-Item -Path $ShortcutPath -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed Start Menu shortcut"
    }

    if (Test-Path $UninstallKey) {
        Remove-Item -Path $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed Add/Remove Programs entry"
    }

    Write-Host ""
    Write-Host "tkr-workbench uninstalled."
    exit 0
}

# --- Detect architecture -------------------------------------------------

# RuntimeInformation.OSArchitecture came back empty in a user's Windows
# PowerShell 5.1 session and refused an x64 machine. The environment is set
# by Windows in every host; PROCESSOR_ARCHITEW6432 carries the real OS
# architecture when this runs in 32-bit PowerShell on 64-bit Windows.
$Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($Arch -ne "AMD64") {
    Write-Error "tkr-workbench Windows builds are only available for x64 (detected: $Arch)"
    exit 1
}
$ArchLabel = "x64"

# --- Resolve version -------------------------------------------------
#
# Deliberately NOT /releases/latest: that endpoint returns the newest
# release across every tag in the repo, and this repo also carries the
# CLI's "v*" releases. A workbench install must resolve only within the
# "workbench-v*" tag namespace.

if ($Version) {
    $Tag = $Version
    if ($Tag -notlike "workbench-v*") {
        $Tag = "workbench-v$($Tag.TrimStart('v'))"
    }
    Write-Host "Using pinned version: $Tag"
} else {
    Write-Host "Fetching workbench releases..."
    $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases"
    $WorkbenchReleases = @($Releases | Where-Object { $_.tag_name -like "workbench-v*" })
    if ($WorkbenchReleases.Count -eq 0) {
        Write-Error "No workbench-v* releases found in $Repo.`nThe workbench release pipeline may not have published anything yet."
        exit 1
    }

    # Sort by the numeric version embedded in the tag (workbench-vX.Y.Z),
    # newest first. Falls back to created_at ordering if a tag does not
    # parse as a version, so a malformed tag cannot crash resolution.
    $Sorted = $WorkbenchReleases | Sort-Object -Property @{
        Expression = {
            $v = $_.tag_name -replace '^workbench-v', ''
            try { [version]($v -replace '[^0-9.]', '') } catch { [version]"0.0.0" }
        }
    }, created_at -Descending
    $Tag = $Sorted[0].tag_name
    if (-not $Tag) {
        Write-Error "Could not determine the newest workbench-v* release"
        exit 1
    }
}

$VersionLabel = $Tag -replace '^workbench-v', ''
$Artifact = "tkr-workbench-$VersionLabel-windows-$ArchLabel.zip"

Write-Host "Installing tkr-workbench $VersionLabel (windows/$ArchLabel)..."

# --- Download + verify -------------------------------------------------

$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"
$TempDir = Join-Path $env:TEMP "tkr-workbench-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    $ArtifactPath = Join-Path $TempDir $Artifact
    $ChecksumPath = Join-Path $TempDir "checksums.sha256"

    Write-Host "Downloading $Artifact..."
    Invoke-WebRequest -Uri "$BaseUrl/$Artifact" -OutFile $ArtifactPath -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/checksums.sha256" -OutFile $ChecksumPath -UseBasicParsing

    $ExpectedLine = Get-Content $ChecksumPath | Where-Object { $_ -match [regex]::Escape($Artifact) }
    if (-not $ExpectedLine) {
        Write-Error "No checksum found for $Artifact in checksums.sha256"
        exit 1
    }
    $Expected = ($ExpectedLine -split '\s+')[0]

    $ActualHash = (Get-Sha256Hex -Path $ArtifactPath).ToLower()
    if ($ActualHash -ne $Expected) {
        Write-Error "Checksum mismatch`n  expected: $Expected`n  got:      $ActualHash"
        exit 1
    }
    Write-Host "Checksum verified."

    # --- Extract to a staging directory ---------------------------------
    #
    # The zip's top-level contents are tkr-workbench.exe plus a conpty\
    # directory. Extracting to a fresh staging dir first (rather than
    # straight into $InstallDir) means the swap below is a single
    # directory rename, so the exe and conpty\ always move together and
    # never end up out of sync.

    $StageDir = Join-Path $TempDir "staged"
    Expand-Archive -Path $ArtifactPath -DestinationPath $StageDir -Force

    $StagedExe = Join-Path $StageDir "tkr-workbench.exe"
    $StagedConpty = Join-Path $StageDir "conpty"
    if (-not (Test-Path $StagedExe)) {
        Write-Error "Downloaded zip did not contain tkr-workbench.exe at its top level - unexpected zip layout"
        exit 1
    }
    if (-not (Test-Path $StagedConpty)) {
        Write-Error "Downloaded zip did not contain a conpty\ directory - unexpected zip layout"
        exit 1
    }

    # --- Install (rename-before-copy) ------------------------------------
    #
    # The app may be running during an upgrade, which locks both
    # tkr-workbench.exe and conpty\conpty.dll. A plain overwrite silently
    # fails (or partially succeeds, leaving exe and conpty\ mismatched) in
    # that case. Renaming the whole existing install dir aside first
    # mirrors install.ps1's rename-before-copy pattern for tkr.exe, but at
    # directory granularity so the exe and conpty\ move as one unit -
    # Windows allows renaming a directory even while a file inside it is
    # open, so this succeeds even with the app running; only deleting the
    # renamed-aside copy afterward can fail while it is running.

    $InstallParent = Split-Path -Parent $InstallDir
    New-Item -ItemType Directory -Path $InstallParent -Force | Out-Null

    $OldInstallDir = "$InstallDir.old"
    if (Test-Path $OldInstallDir) { Remove-Item $OldInstallDir -Recurse -Force -ErrorAction SilentlyContinue }

    $HadPrevious = Test-Path $InstallDir
    if ($HadPrevious) {
        try {
            Rename-Item -Path $InstallDir -NewName (Split-Path -Leaf $OldInstallDir) -ErrorAction Stop
        } catch {
            Write-Error "tkr-workbench appears to be locked (another process is using it).`nClose tkr-workbench and retry.`nDetails: $_"
            exit 1
        }
    }

    try {
        Move-Item -Path $StageDir -Destination $InstallDir -ErrorAction Stop
    } catch {
        if ($HadPrevious -and (Test-Path $OldInstallDir)) {
            Rename-Item -Path $OldInstallDir -NewName (Split-Path -Leaf $InstallDir) -ErrorAction SilentlyContinue
        }
        Write-Error "Failed to install tkr-workbench: $_"
        exit 1
    }

    if (Test-Path $OldInstallDir) {
        Remove-Item -Path $OldInstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Installed tkr-workbench to $InstallDir"

    # --- Version record ---------------------------------------------------
    #
    # The release binary is linked -H windowsgui (no console), so running
    # it with --version cannot be captured interactively the way tkr.exe's
    # install verification does. The sidecar file is what the installer
    # (and a future upgrade run) trusts instead.

    $SidecarPath = Join-Path $InstallDir ".installed-version"
    $SidecarLines = @(
        "tag=$Tag",
        "version=$VersionLabel",
        "arch=$ArchLabel",
        "installed_at=$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
    )
    Set-Content -Path $SidecarPath -Value $SidecarLines -Encoding ascii
    Write-Host "Version recorded: $SidecarPath"

    # --- Start Menu shortcut ----------------------------------------------

    try {
        $ShortcutDir = Split-Path -Parent $ShortcutPath
        New-Item -ItemType Directory -Path $ShortcutDir -Force | Out-Null
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $ExePath
        $Shortcut.WorkingDirectory = $InstallDir
        $Shortcut.Description = "tkr-workbench"
        $Shortcut.Save()
        Write-Host "Start Menu shortcut created: $ShortcutPath"
    } catch {
        Write-Warning "Could not create Start Menu shortcut: $_"
    }

    # --- Add/Remove Programs entry -----------------------------------------
    #
    # UninstallString is a self-contained command (no dependency on this
    # script file persisting on disk - most users get here via
    # irm | iex, which leaves nothing on disk to point back to).

    try {
        New-Item -Path $UninstallKey -Force | Out-Null
        $UninstallCmd = "powershell -NoProfile -Command " +
            "`"Remove-Item -Recurse -Force '$InstallDir' -ErrorAction SilentlyContinue; " +
            "Remove-Item -Force '$ShortcutPath' -ErrorAction SilentlyContinue; " +
            "Remove-Item -Path '$UninstallKey' -Recurse -Force -ErrorAction SilentlyContinue`""
        New-ItemProperty -Path $UninstallKey -Name "DisplayName" -Value "tkr-workbench" -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "DisplayVersion" -Value $VersionLabel -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "Publisher" -Value "bpeers01" -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "InstallLocation" -Value $InstallDir -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "DisplayIcon" -Value $ExePath -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "UninstallString" -Value $UninstallCmd -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $UninstallKey -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "Registered in Add/Remove Programs."
    } catch {
        Write-Warning "Could not register Add/Remove Programs entry: $_"
    }

    # --- SmartScreen note ---------------------------------------------------

    Write-Host ""
    Write-Host "Note: tkr-workbench.exe is not code-signed. On first launch, Windows"
    Write-Host "SmartScreen will likely show an 'unrecognized app' warning. This is"
    Write-Host "expected for an unsigned binary, not a sign of a bad download - your"
    Write-Host "download was verified against a published SHA256 checksum above. To"
    Write-Host "proceed: in the SmartScreen dialog, click 'More info', then 'Run anyway'."
    Write-Host ""

    Write-Host "tkr-workbench $VersionLabel installed successfully."
    Write-Host "  App:      $ExePath"
    Write-Host "  Shortcut: $ShortcutPath"
    Write-Host ""
    Write-Host "Launch it from the Start Menu, or run: & `"$ExePath`""
    Write-Host "Uninstall anytime with: .\install-workbench.ps1 -Uninstall"

} finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
