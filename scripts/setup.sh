#!/usr/bin/env bash
# Keet Channel — setup script
# Run from plugin root or any cwd:  bash scripts/setup.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info "Keet Channel setup"
info "Plugin directory: $PLUGIN_DIR"
echo ""

# 1. Node.js >= 24 (the bridge uses Node built-ins and runs under Node, not Pear)
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
    error "Node.js is required. Install Node.js >= 24:"
    error "  https://nodejs.org/en/download/"
    exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
info "Node.js $(node -v) found"
if [ "$NODE_VER" -lt 24 ]; then
    error "Node.js >= 24 required, found $(node -v)"
    exit 1
fi
echo ""

# 2. npm
info "Checking npm..."
if ! command -v npm &>/dev/null; then
    error "npm is required. Install Node.js (includes npm):"
    error "  https://nodejs.org/en/download/"
    exit 1
fi
info "npm $(npm -v) found"
echo ""

# 3. Install root and bridge dependencies. The root postinstall also provisions
#    bridge/node_modules, so this is safe to re-run.
info "Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --no-audit --no-fund
if [ ! -d "$PLUGIN_DIR/bridge/node_modules" ]; then
    info "Installing bridge dependencies..."
    cd "$PLUGIN_DIR/bridge"
    npm install --no-audit --no-fund
fi
echo ""

# 4. Verify the bridge entrypoint and its test command are usable.
info "Verifying installation..."
FAIL=0
if [ -f "$PLUGIN_DIR/bridge/index.js" ]; then
    info "  ✓ Bridge entrypoint present"
else
    error "  ✗ Bridge entrypoint missing"
    FAIL=1
fi
if [ -d "$PLUGIN_DIR/bridge/node_modules" ]; then
    info "  ✓ Bridge dependencies installed"
else
    error "  ✗ Bridge dependencies missing"
    FAIL=1
fi
if node -e "require('$PLUGIN_DIR/bridge/node_modules/blind-pairing/package.json')" &>/dev/null; then
    info "  ✓ blind-pairing present"
else
    error "  ✗ blind-pairing missing"
    FAIL=1
fi
echo ""

if [ "$FAIL" -eq 0 ]; then
    info "Setup completed successfully!"
    info "Access is denied by default. Authorize contacts with:"
    info "  hermes config set env_KEET_ALLOWED_USERS \"<64-hex-identity>,...\""
    info "Then enable the plugin:"
    info "  hermes plugins enable keet-channel"
    info "  hermes gateway restart"
else
    error "Setup failed. Fix the errors above and re-run."
    exit 1
fi
