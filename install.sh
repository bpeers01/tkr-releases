#!/bin/sh
# tkr installer — downloads the latest release binary from GitHub.
# Supports two modes:
#   --cli     CLI-only: installs the tkr binary to PATH + shell hook (default)
#   --plugin  Full plugin: binary + hooks + skills + scripts + adapters for Claude Code
#
# Auto-detection: if neither flag is given, checks whether Claude Code is
# installed. If found, offers plugin mode; otherwise installs CLI-only.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
#   curl -fsSL ... | sh -s -- --plugin
#   ./install.sh --plugin
#   ./install.sh --cli
#
# Environment variables:
#   TKR_INSTALL_DIR     — override binary install directory (default: ~/.local/bin)
#   TKR_PLUGIN_DIR      — override plugin install directory (default: ~/.local/share/tkr)
#   TKR_VERSION         — pin a specific version (default: latest)
#   TKR_REQUIRE_COSIGN  — set to 1 to fail closed if cosign is unavailable
#                         or signature verification fails. By default the
#                         installer warns and falls back to SHA256-only
#                         verification when cosign is missing.
#   TKR_SKIP_COSIGN     — set to 1 to skip cosign verification entirely
#                         (NOT RECOMMENDED — defeats the supply-chain
#                         protection in SEC-ACT-0003).

set -e

REPO="bpeers01/tkr-releases"
SOURCE_REPO="bpeers01/tkr"  # cosign signing identity (private source repo workflow)

# --- Parse arguments ---

MODE=""
for arg in "$@"; do
  case "$arg" in
    --cli)    MODE="cli" ;;
    --plugin) MODE="plugin" ;;
  esac
done

# --- Detect platform ---

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  GOOS="linux" ;;
  Darwin) GOOS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) GOOS="windows" ;;
  *) echo "Error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *) echo "Error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Windows only ships amd64; darwin ships both; linux ships amd64
if [ "$GOOS" = "windows" ] && [ "$GOARCH" != "amd64" ]; then
  echo "Error: Windows builds are only available for amd64" >&2
  exit 1
fi
if [ "$GOOS" = "linux" ] && [ "$GOARCH" != "amd64" ]; then
  echo "Error: Linux builds are only available for amd64 (arm64 coming soon)" >&2
  exit 1
fi

EXT=""
if [ "$GOOS" = "windows" ]; then
  EXT=".exe"
fi

ARTIFACT="tkr-${GOOS}-${GOARCH}${EXT}"

# --- Auto-detect mode if not specified ---

if [ -z "$MODE" ]; then
  if command -v claude >/dev/null 2>&1; then
    echo "Claude Code detected. Installing in plugin mode (--cli to skip)."
    MODE="plugin"
  else
    MODE="cli"
  fi
fi

echo "Install mode: ${MODE}"

# --- Resolve version ---

if [ -n "${TKR_VERSION:-}" ]; then
  TAG="$TKR_VERSION"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*: "//;s/".*//')
  if [ -z "$TAG" ]; then
    echo "Error: could not determine latest release" >&2
    exit 1
  fi
fi

echo "Installing tkr ${TAG} (${GOOS}/${GOARCH})..."

# --- Download ---

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"
CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.sha256"
SIGNATURE_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.sha256.bundle"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

curl -fsSL -o "${WORK_DIR}/${ARTIFACT}" "$URL"
curl -fsSL -o "${WORK_DIR}/checksums.sha256" "$CHECKSUM_URL"

# --- Verify cosign signature on checksums.sha256 (SEC-ACT-0003 / 0010) ---
#
# The release workflow signs checksums.sha256 with cosign keyless. By
# verifying the signature first, we anchor trust in GitHub Actions OIDC
# instead of trusting whatever bytes the CDN happens to return.
# Once the checksums file is trusted, the per-binary SHA256 check below
# transitively trusts the binary. Override flags:
#   TKR_REQUIRE_COSIGN=1 → fail closed if cosign is missing or verify fails
#   TKR_SKIP_COSIGN=1    → skip entirely (not recommended)

if [ "${TKR_SKIP_COSIGN:-}" = "1" ]; then
  echo "Warning: TKR_SKIP_COSIGN=1 — supply-chain signature check disabled" >&2
elif command -v cosign >/dev/null 2>&1; then
  echo "Fetching cosign bundle..."
  if ! curl -fsSL -o "${WORK_DIR}/checksums.sha256.bundle" "$SIGNATURE_URL"; then
    if [ "${TKR_REQUIRE_COSIGN:-}" = "1" ]; then
      echo "Error: cosign bundle missing for ${TAG} and TKR_REQUIRE_COSIGN=1" >&2
      echo "  bundle URL: $SIGNATURE_URL" >&2
      exit 1
    fi
    echo "Warning: cosign bundle not found for ${TAG} (older releases were unsigned); falling back to SHA256-only verification" >&2
  else
    # Pin the trusted identity to the tkr release workflow on a v* tag.
    # This is what makes cosign verification meaningful — without these
    # flags, cosign would accept any sigstore-signed blob.
    if cosign verify-blob \
      --bundle "${WORK_DIR}/checksums.sha256.bundle" \
      --certificate-identity-regexp "https://github.com/${SOURCE_REPO}/\.github/workflows/release\.yml@refs/tags/v.*" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "${WORK_DIR}/checksums.sha256" >/dev/null 2>&1; then
      echo "Cosign signature verified (issuer: github actions OIDC, identity: ${SOURCE_REPO} release workflow)."
    else
      echo "Error: cosign signature verification failed for checksums.sha256" >&2
      echo "  This may indicate the release was tampered with." >&2
      echo "  To debug, re-run with: cosign verify-blob --bundle checksums.sha256.bundle ... checksums.sha256" >&2
      exit 1
    fi
  fi
elif [ "${TKR_REQUIRE_COSIGN:-}" = "1" ]; then
  echo "Error: cosign not installed and TKR_REQUIRE_COSIGN=1" >&2
  echo "  Install: https://github.com/sigstore/cosign#installation" >&2
  exit 1
else
  echo "Note: cosign not installed — skipping signature check (SHA256 still verified)." >&2
  echo "  For supply-chain protection, install cosign and re-run." >&2
  echo "  See https://github.com/sigstore/cosign#installation" >&2
fi

# --- Verify SHA256 checksum ---

EXPECTED=$(grep -F "$ARTIFACT" "${WORK_DIR}/checksums.sha256" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "Error: no checksum found for ${ARTIFACT} in checksums.sha256" >&2
  exit 1
else
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
  else
    echo "Error: no sha256 checksum tool found (sha256sum or shasum required)" >&2
    exit 1
  fi

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Error: checksum mismatch" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  got:      $ACTUAL" >&2
    exit 1
  fi
  echo "Checksum verified."
fi

# --- Install binary ---

INSTALL_DIR="${TKR_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

DEST="${INSTALL_DIR}/tkr${EXT}"
mv "${WORK_DIR}/${ARTIFACT}" "$DEST"
chmod +x "$DEST"

echo "Installed tkr to ${DEST}"

# --- PATH check ---

case ":$PATH:" in
  *":${INSTALL_DIR}:"*)
    ;;
  *)
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

# --- CLI-only: done ---

if [ "$MODE" = "cli" ]; then
  echo ""
  echo "Set up Claude Code integration:"
  echo "  tkr init -g"
  exit 0
fi

# ==========================================================================
# Plugin mode: install hooks, skills, scripts, adapters for Claude Code
# ==========================================================================

# Manual hook wiring — copies hooks and updates Claude Code settings.json
# Used when `claude plugin install` is unavailable or fails.
install_hooks_manually() {
  local plugin_root="$1"
  local claude_hooks_dir="$HOME/.claude/hooks"

  mkdir -p "$claude_hooks_dir"

  # Copy hook scripts
  for hook_file in "$plugin_root"/hooks/*; do
    [ -f "$hook_file" ] || continue
    cp "$hook_file" "$claude_hooks_dir/"
    chmod +x "$claude_hooks_dir/$(basename "$hook_file")"
  done

  echo "Hooks copied to ${claude_hooks_dir}"

  # Wire hooks into settings.json
  local settings_file="$HOME/.claude/settings.json"
  if [ -f "$settings_file" ]; then
    # Check if tkr hooks are already registered
    if grep -q "tkr-rewrite" "$settings_file" 2>/dev/null; then
      echo "Hooks already registered in settings.json"
      return
    fi
  fi

  echo ""
  echo "To complete manual setup, add these hooks to ${settings_file}:"
  echo '  "hooks": {'
  echo '    "PreToolUse": [{ "type": "command", "command": "bash '"${claude_hooks_dir}"'/tkr-rewrite.sh" }],'
  echo '    "SessionStart": [{ "type": "command", "command": "node '"${claude_hooks_dir}"'/session-start.js" }],'
  echo '    "UserPromptSubmit": [{ "type": "command", "command": "node '"${claude_hooks_dir}"'/user-prompt-submit.js" }]'
  echo '  }'
}

echo ""
echo "Installing plugin components..."

PLUGIN_DIR="${TKR_PLUGIN_DIR:-$HOME/.local/share/tkr}"

# If running from a local repo clone (./install.sh), use it directly.
# When piped via curl, $0 is "sh" or "/dev/stdin" — dirname won't match.
SCRIPT_SOURCE=""
if [ -f "$(dirname "$0")/.claude-plugin/plugin.json" ] 2>/dev/null; then
  SCRIPT_SOURCE="$(cd "$(dirname "$0")" && pwd)"
fi

if [ -n "$SCRIPT_SOURCE" ]; then
  # Running from repo clone — use it directly as plugin root
  echo "Source: local clone at ${SCRIPT_SOURCE}"
  PLUGIN_DIR="$SCRIPT_SOURCE"
else
  # Running from curl-pipe — download plugin bundle from release
  BUNDLE_URL="https://github.com/${REPO}/releases/download/${TAG}/tkr-plugin.tar.gz"
  echo "Downloading plugin bundle..."
  if ! curl -fsSL -o "${WORK_DIR}/tkr-plugin.tar.gz" "$BUNDLE_URL"; then
    echo "Error: failed to download plugin bundle from ${BUNDLE_URL}" >&2
    echo "  The plugin bundle may not be available for this release." >&2
    echo "  Use --cli for binary-only install, or clone the repo and run ./install.sh --plugin" >&2
    exit 1
  fi

  # Verify plugin bundle checksum (already in checksums.sha256)
  BUNDLE_EXPECTED=$(grep -F "tkr-plugin.tar.gz" "${WORK_DIR}/checksums.sha256" | awk '{print $1}')
  if [ -n "$BUNDLE_EXPECTED" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      BUNDLE_ACTUAL=$(sha256sum "${WORK_DIR}/tkr-plugin.tar.gz" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      BUNDLE_ACTUAL=$(shasum -a 256 "${WORK_DIR}/tkr-plugin.tar.gz" | awk '{print $1}')
    fi
    if [ -n "$BUNDLE_ACTUAL" ] && [ "$BUNDLE_ACTUAL" != "$BUNDLE_EXPECTED" ]; then
      echo "Error: plugin bundle checksum mismatch" >&2
      echo "  expected: $BUNDLE_EXPECTED" >&2
      echo "  got:      $BUNDLE_ACTUAL" >&2
      exit 1
    fi
    echo "Plugin bundle checksum verified."
  fi

  # Extract to plugin dir
  mkdir -p "$PLUGIN_DIR"
  tar xzf "${WORK_DIR}/tkr-plugin.tar.gz" -C "$PLUGIN_DIR"
  chmod +x "$PLUGIN_DIR"/scripts/*.sh "$PLUGIN_DIR"/adapters/*.sh "$PLUGIN_DIR"/hooks/*.sh 2>/dev/null || true
  echo "Plugin files extracted to ${PLUGIN_DIR}"
fi

# --- Register with Claude Code ---

echo "Registering plugin with Claude Code..."

if command -v claude >/dev/null 2>&1; then
  # Attempt native plugin install
  if claude plugin install "$PLUGIN_DIR" 2>/dev/null; then
    echo "Plugin registered via 'claude plugin install'."
  else
    echo "Note: 'claude plugin install' failed — falling back to manual hook wiring." >&2
    # Manual hook wiring fallback
    install_hooks_manually "$PLUGIN_DIR"
  fi
else
  echo "Claude Code CLI not found — wiring hooks manually."
  install_hooks_manually "$PLUGIN_DIR"
fi

# --- Create runtime state directory ---

TKR_STATE_DIR="${HOME}/.tkr"
mkdir -p "${TKR_STATE_DIR}/contracts" "${TKR_STATE_DIR}/delegations" "${TKR_STATE_DIR}/validation"
echo "Runtime state directory: ${TKR_STATE_DIR}"

# --- Done ---

echo ""
echo "tkr plugin installed successfully."
echo "  Binary:  ${DEST}"
echo "  Plugin:  ${PLUGIN_DIR}"
echo "  State:   ${TKR_STATE_DIR}"
echo ""
echo "Available skills: /tkr-search, /tkr-delegate, /tkr-brevity, /tkr-compress, /tkr-status, /tkr-config"
echo ""
echo "Set up shell hook (optional, for terminal use):"
echo "  tkr init -g"
