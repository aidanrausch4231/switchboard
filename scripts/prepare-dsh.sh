#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 ]]; then echo "Usage: $0 <clean-dsh> <out-dir>" >&2; exit 2; fi
plugin=$(cd "$(dirname "$0")/.." && pwd)
source=$(realpath "$1")
out=$(realpath -m "$2")
lock=$(realpath -m "$out.switchboard-prepare.lock")
fail() { echo "$*" >&2; exit 1; }
# Resolve both paths (including existing symlinks) before any filesystem writes.
for path in "$out" "$lock"; do
  [[ $path != "$source" && $path != "$source/"* ]] || fail 'Output and lock must be outside the source checkout'
done
[[ -z $(git -C "$source" status --porcelain) ]] || fail 'Source must be clean'
mkdir -p "$(dirname "$out")"
# Serialize preparation, including a resumed install/build.
exec 9>"$lock"
flock -n 9 || fail 'Preparation already running'
revision=$(git -C "$source" rev-parse HEAD)
patches=("$plugin"/patches/dsh/*.patch)
fingerprints=$(cd "$plugin" && sha256sum patches/dsh/*.patch)
identity=$(printf 'switchboard-prepare-v1\nsource=%s\nrevision=%s\n%s\n' "$source" "$revision" "$fingerprints")
marker="$out/.switchboard-prepare"
# Compute the only accepted patched tree without changing the source's index/worktree.
index=$(mktemp); rm "$index"
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git -C "$source" read-tree "$revision"
GIT_INDEX_FILE="$index" git -C "$source" apply --cached "${patches[@]}"
expected=$(GIT_INDEX_FILE="$index" git -C "$source" write-tree)
base=$(git -C "$source" rev-parse "$revision^{tree}")
if [[ -e $out ]]; then
  [[ -f $marker && ! -L $marker && $(<"$marker") == "$identity" ]] || fail 'Output is not a matching owned runtime'
  [[ $(git -C "$out" rev-parse --show-toplevel) == "$out" ]] || fail 'Output is not a worktree root'
  [[ $(git -C "$out" rev-parse --path-format=absolute --git-common-dir) == "$(git -C "$source" rev-parse --path-format=absolute --git-common-dir)" ]] || fail 'Output belongs to another repository'
  [[ $(git -C "$out" rev-parse HEAD) == "$revision" ]] || fail 'Output revision changed'
  git -C "$out" diff --quiet || fail 'Output has unexpected unstaged changes'
  [[ $(git -C "$out" ls-files --others --exclude-standard) == '.switchboard-prepare' ]] || fail 'Output has unexpected untracked files'
else
  git -C "$source" worktree add --detach "$out" "$revision"
  printf '%s\n' "$identity" > "$marker"
fi
actual=$(git -C "$out" write-tree)
if [[ $actual == "$base" ]]; then
  # One atomic patch application; a failed install/build can resume from this tree.
  git -C "$out" apply --index "${patches[@]}"
elif [[ $actual != "$expected" ]]; then
  fail 'Output has unexpected staged changes'
fi
[[ $(git -C "$out" write-tree) == "$expected" ]] || fail 'Patched tree mismatch'
export NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=3072}
export RAYON_NUM_THREADS=${RAYON_NUM_THREADS:-2}
(cd "$out" && pnpm install --frozen-lockfile && pnpm run build)
git -C "$out" diff --quiet || fail 'Build unexpectedly modified tracked files'
[[ $(git -C "$out" write-tree) == "$expected" ]] || fail 'Build unexpectedly modified the index'
[[ -z $(git -C "$source" status --porcelain) ]] || fail 'Source changed during preparation'
echo "Prepared runtime: $out (local patch intentionally staged, not committed)"
