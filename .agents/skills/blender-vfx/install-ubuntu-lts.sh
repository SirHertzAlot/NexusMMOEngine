#!/usr/bin/env bash
# Blender VFX skill — Ubuntu LTS (22.04 / 24.04) install.
#
# Installs what an agent needs to drive Blender over MCP:
#   1. Blender (apt; see note for newer versions)
#   2. uv (Python tool runner for the MCP server)
#   3. The vendored Blender MCP addon, staged for Blender
#   4. Prints the MCP client config block to paste into your client
#
# Idempotent: safe to re-run. Nothing is enabled inside Blender
# automatically — the final manual step is listed at the end.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$SKILL_DIR/vendor/blender-mcp"

echo "== 1/4 Blender =="
if command -v blender >/dev/null 2>&1; then
  echo "blender already installed: $(blender --version | head -1)"
else
  sudo apt-get update && sudo apt-get install -y blender
  # NOTE: Ubuntu 24.04's apt Blender is 4.0.x, 22.04's is 3.x — both
  # work with the addon. For the newest Blender, prefer the official
  # tarball from blender.org or `sudo snap install blender --classic`
  # and re-run this script (it will detect and skip).
fi

echo "== 2/4 uv =="
if command -v uvx >/dev/null 2>&1; then
  echo "uv already installed: $(uvx --version)"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "== 3/4 Blender addon =="
ADDON_DIR="$HOME/.config/blender/$(blender --version | awk 'NR==1{print $2}' | cut -d. -f1,2)/scripts/addons"
mkdir -p "$ADDON_DIR"
cp "$VENDOR/addon.py" "$ADDON_DIR/blender_mcp_addon.py"
echo "addon staged at: $ADDON_DIR/blender_mcp_addon.py"

echo "== 4/4 MCP client config =="
cat <<EOF

Add this server to your MCP client's config, then restart the client:

  "blender": {
    "command": "uvx",
    "args": [
      "--python", ">=3.10",
      "--from", "$VENDOR",
      "blender-mcp"
    ]
  }

(If your client runs the packaged release instead, the args are just
["blender-mcp"] after 'uvx'. The --from form runs THIS vendored copy.)

Final manual step in Blender:
  Edit > Preferences > Add-ons > enable "Blender MCP"
  (staged above as blender_mcp_addon.py if it doesn't appear, use
  Install... and pick that file). In the addon's preferences, leave
  telemetry consent OFF (house rule — see SKILL.md). Then press
  "Connect to MCP server" in the Blender MCP panel (3D Viewport
  sidebar) before asking an agent to drive it.
EOF
echo "Done."
