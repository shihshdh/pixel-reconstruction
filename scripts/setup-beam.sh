#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TOOLS="$PWD/.beam-tools"
mkdir -p "$TOOLS"
if [ ! -x "$TOOLS/uv" ]; then
  curl -LsSf https://astral.sh/uv/install.sh -o "$TOOLS/install-uv.sh"
  UV_INSTALL_DIR="$TOOLS" UV_NO_MODIFY_PATH=1 sh "$TOOLS/install-uv.sh"
fi
if [ ! -x "$PWD/.venv-beam/bin/beam" ]; then
  "$TOOLS/uv" venv --allow-existing "$PWD/.venv-beam"
  "$TOOLS/uv" pip install --python "$PWD/.venv-beam/bin/python" beam-client
fi
"$PWD/.venv-beam/bin/beam" config create --help
