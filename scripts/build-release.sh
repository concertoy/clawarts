#!/bin/bash
set -e

VERSION=$(node -e "console.log(require('./package.json').version)")
RELEASE_DIR="release/clawarts-v${VERSION}"

echo "Building clawarts v${VERSION}..."

rm -rf release
mkdir -p "$RELEASE_DIR/lib" "$RELEASE_DIR/bin"

# ── Bundle CLI and server into single files ────────────────────────
# Banner: create a real require() so CJS deps (commander, etc.) can
# resolve node: built-ins when running inside an ESM bundle.
BANNER="import{createRequire as __cr}from'module';var require=__cr(import.meta.url);"

npx esbuild src/cli/index.ts \
  --bundle --platform=node --format=esm \
  --target=node20 --outfile="$RELEASE_DIR/lib/cli.mjs" \
  --banner:js="$BANNER" \
  --define:CLAWARTS_VERSION=\""$VERSION"\"

npx esbuild src/index.ts \
  --bundle --platform=node --format=esm \
  --target=node20 --outfile="$RELEASE_DIR/lib/server.mjs" \
  --banner:js="$BANNER" \
  --define:CLAWARTS_VERSION=\""$VERSION"\"

# ── Wrapper scripts ───────────────────────────────────────────────
cat > "$RELEASE_DIR/bin/clawarts" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../lib/cli.mjs" "$@"
EOF
chmod +x "$RELEASE_DIR/bin/clawarts"

cat > "$RELEASE_DIR/bin/clawarts-server" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../lib/server.mjs" "$@"
EOF
chmod +x "$RELEASE_DIR/bin/clawarts-server"

# ── Tarball + manifest ────────────────────────────────────────────
TARBALL="release/clawarts-v${VERSION}-darwin.tar.gz"
tar -czf "$TARBALL" -C release "clawarts-v${VERSION}"

CHECKSUM=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)

cat > release/manifest.json << MANIFEST
{
  "version": "$VERSION",
  "platforms": {
    "darwin": {
      "checksum": "$CHECKSUM",
      "file": "clawarts-v${VERSION}-darwin.tar.gz"
    }
  }
}
MANIFEST

echo ""
echo "Release artifacts in release/:"
ls -lh "$TARBALL" release/manifest.json
echo "SHA256: $CHECKSUM"
echo ""
echo "To publish:"
echo "  git tag v${VERSION} && git push origin v${VERSION}"
echo "  gh release create v${VERSION} $TARBALL release/manifest.json --title \"v${VERSION}\""
