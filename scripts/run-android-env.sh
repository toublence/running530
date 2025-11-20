#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1090
source "$SCRIPT_DIR/android-env.sh"

if [[ $# -eq 0 ]]; then
  exec "${SHELL:-/bin/bash}"
else
  exec "$@"
fi
