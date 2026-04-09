#!/bin/sh
# tkr installer — downloads the latest release binary from GitHub.
# Usage: curl -fsSL https://raw.githubusercontent.com/bpeers01/tkr-releases/main/install.sh | sh
#
# Environment variables:
#   TKR_INSTALL_DIR  — override install directory (default: ~/.local/bin)
#   TKR_VERSION      — pin a specific version (default: latest)

set -e

REPO="bpeers01/tkr-releases"

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

# --- Resolve version ---

if [ -n "$TKR_VERSION" ]; then
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

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

curl -fsSL -o "${WORK_DIR}/${ARTIFACT}" "$URL"
curl -fsSL -o "${WORK_DIR}/checksums.sha256" "$CHECKSUM_URL"

# --- Verify checksum ---

EXPECTED=$(grep -F "$ARTIFACT" "${WORK_DIR}/checksums.sha256" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "Warning: no checksum found for ${ARTIFACT}, skipping verification" >&2
else
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "${WORK_DIR}/${ARTIFACT}" | awk '{print $1}')
  else
    echo "Warning: no sha256 tool found, skipping checksum verification" >&2
    ACTUAL="$EXPECTED"
  fi

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Error: checksum mismatch" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  got:      $ACTUAL" >&2
    exit 1
  fi
  echo "Checksum verified."
fi

# --- Install ---

INSTALL_DIR="${TKR_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"

DEST="${INSTALL_DIR}/tkr${EXT}"
mv "${WORK_DIR}/${ARTIFACT}" "$DEST"
chmod +x "$DEST"

echo "Installed tkr to ${DEST}"

# --- PATH check ---

case ":$PATH:" in
  *":${INSTALL_DIR}:"*)
    echo ""
    echo "Set up Claude Code integration:"
    echo "  tkr init -g"
    ;;
  *)
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "Then set up Claude Code integration:"
    echo "  tkr init -g"
    ;;
esac
