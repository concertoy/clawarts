#!/bin/bash
set -e

REPO="concertoy/clawarts"
INSTALL_DIR="$HOME/.clawarts"
BIN_DIR="$HOME/.local/bin"

# ── macOS only ────────────────────────────────────────────────────
if [ "$(uname -s)" != "Darwin" ]; then
    echo "This installer only supports macOS." >&2
    exit 1
fi

# ── Require node ──────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required but not installed." >&2
    echo "Install it from https://nodejs.org or: brew install node" >&2
    exit 1
fi

# ── Require curl ──────────────────────────────────────────────────
if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required but not installed." >&2
    exit 1
fi

# ── Resolve version ──────────────────────────────────────────────
TARGET="${1:-latest}"

if [ "$TARGET" = "latest" ] || [ "$TARGET" = "stable" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
elif [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    VERSION="$TARGET"
else
    echo "Usage: $0 [latest|VERSION]" >&2
    exit 1
fi

if [ -z "$VERSION" ]; then
    echo "Could not determine latest version." >&2
    exit 1
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/v${VERSION}"
TARBALL_NAME="clawarts-v${VERSION}-darwin.tar.gz"

# ── Download ─────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Installing clawarts v${VERSION}..."

curl -fsSL "$DOWNLOAD_URL/manifest.json" -o "$TMPDIR/manifest.json"
curl -fsSL "$DOWNLOAD_URL/$TARBALL_NAME" -o "$TMPDIR/$TARBALL_NAME"

# ── Verify checksum ──────────────────────────────────────────────
if command -v jq >/dev/null 2>&1; then
    EXPECTED=$(jq -r '.platforms.darwin.checksum' "$TMPDIR/manifest.json")
else
    EXPECTED=$(grep -o '"checksum"[[:space:]]*:[[:space:]]*"[a-f0-9]\{64\}"' "$TMPDIR/manifest.json" \
        | grep -o '[a-f0-9]\{64\}')
fi

if [ -z "$EXPECTED" ] || [[ ! "$EXPECTED" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Failed to read checksum from manifest." >&2
    exit 1
fi

ACTUAL=$(shasum -a 256 "$TMPDIR/$TARBALL_NAME" | cut -d' ' -f1)

if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Checksum verification failed." >&2
    echo "  expected: $EXPECTED" >&2
    echo "  got:      $ACTUAL" >&2
    rm -f "$TMPDIR/$TARBALL_NAME"
    exit 1
fi

# ── Install ──────────────────────────────────────────────────────
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
tar -xzf "$TMPDIR/$TARBALL_NAME" -C "$INSTALL_DIR" --strip-components=1

ln -sf "$INSTALL_DIR/bin/clawarts" "$BIN_DIR/clawarts"

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "Installed to $INSTALL_DIR"
echo "Symlinked to $BIN_DIR/clawarts"

# Check if BIN_DIR is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    echo ""
    echo "Add ~/.local/bin to your PATH:"
    echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
fi

echo ""
echo "Run 'clawarts setup' to get started."
