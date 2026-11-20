#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${BROWSER_BACKUP_RECIPIENT:?Set an age public recipient}"
output=${1:?Pass an encrypted output path ending in .age}
[[ "$output" == *.age && ! -e "$output" ]] || { echo 'Use a new .age output file' >&2; exit 1; }
command -v age >/dev/null
compose_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
compose=(docker compose -f "$compose_dir/compose.yml" -f "$compose_dir/compose.browser.yml")
temporary=$(mktemp "${output}.XXXXXX")
resume() { rm -f -- "$temporary"; "${compose[@]}" start browser >/dev/null; }
trap resume EXIT
"${compose[@]}" stop -t 60 browser >/dev/null
# Plaintext is streamed directly to age, never stored as an intermediate archive.
"${compose[@]}" run --rm --no-deps --entrypoint tar browser -C /profiles -cf - . |
  age -r "$BROWSER_BACKUP_RECIPIENT" > "$temporary"
# Hard-link atomically refuses to replace an existing backup, including a race.
ln -- "$temporary" "$output"
echo 'Encrypted browser profile backup saved.'
