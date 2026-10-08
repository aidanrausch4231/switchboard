#!/usr/bin/env bash
# User-facing launcher. Tests must set an isolated DSH_HOME; never run this during acceptance on ~/.dsh.
set -euo pipefail
plugin=$(cd "$(dirname "$0")/.." && pwd)
runtime=$(realpath "${DSH_RUNTIME:-$plugin/../dsh-runtime}")
[[ -f $runtime/apps/cli/lib/bin.js ]] || { echo 'Run scripts/prepare-dsh.sh first' >&2; exit 1; }
cd "$runtime"
if [[ ! -d ${DSH_HOME:-$HOME/.dsh}/profiles/switchboard ]]; then
  pnpm dsh --profile switchboard --from-default-profile web --dump-config >/dev/null
fi
pnpm dsh plugin --profile switchboard add "$plugin/packages/bundle"
exec pnpm dsh --profile switchboard "$@"
