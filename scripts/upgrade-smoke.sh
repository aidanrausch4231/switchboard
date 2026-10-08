#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo "Usage: $0 <dsh-path>" >&2; exit 2; }
plugin=$(cd "$(dirname "$0")/.." && pwd)
target=$(realpath "$1")
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
export RAYON_NUM_THREADS=${RAYON_NUM_THREADS:-2}
(cd "$target" && pnpm run build)
cd "$plugin"
node scripts/smoke-linked.mjs "$target"
