#!/usr/bin/env bash
# check-no-study-writes.sh
#
# Defense-in-depth lint guard. The service-role key bypasses RLS, so the only
# thing standing between this app and a mutation of IRB-covered study data is
# discipline. `cbFrom()` enforces this at runtime (see lib/supabase/guard.ts);
# this script enforces it at lint time by refusing any write verb chained to a
# study table.
#
# It greps app/ and lib/ for a study-table `.from(...)` and, if a write verb
# (.insert/.update/.delete/.upsert) appears on the same line OR within the next
# few lines (a chained call), it fails with file:line of the offending `.from`.
#
# Conservative / false-positive-safe: it only fires when BOTH a study-table
# `.from(` AND a write verb are present in the same small window. Read-only
# `.from('studies').select(...)` never trips it.
#
# Excludes node_modules, and the two client modules that legitimately read
# study tables (lib/supabase/server.ts, lib/supabase/service.ts).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Study tables that are read-only for this app.
STUDY_FROM_RE="from\((['\"])(studies|study_events|study_snapshots|users|onboarding)"
WRITE_VERB_RE="\.(insert|update|delete|upsert)\("
WINDOW=5  # lines after a study `.from(` still considered part of the same chain

# Collect candidate source files (app/ and lib/), excluding node_modules and the
# two legitimate study-reading client modules. Uses a `while read` loop (not
# bash-4 `mapfile`) so it runs under macOS's stock bash 3.2.
offenders=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  # Lines (1-based) where a study-table `.from(` appears.
  while IFS=: read -r lineno _; do
    [ -n "${lineno:-}" ] || continue
    end=$((lineno + WINDOW))
    # Examine the window starting at the `.from(` line through WINDOW lines after.
    window="$(sed -n "${lineno},${end}p" "$f")"
    if printf '%s\n' "$window" | grep -qE "$WRITE_VERB_RE"; then
      echo "ERROR: write to read-only study table near $f:$lineno" >&2
      # Indent the offending region for readability. Use a `#`-delimited
      # substitution since paths contain `/` (collides with sed's default s/).
      sed -n "${lineno},${end}p" "$f" | sed "s#^#    $f:$lineno    #" >&2 || true
      offenders=$((offenders + 1))
    fi
  done < <(grep -nE "$STUDY_FROM_RE" "$f" || true)
done < <(
  find app lib -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null \
    | grep -v '/node_modules/' \
    | grep -v -E 'lib/supabase/(server|service)\.ts$' \
    | sort
)

if [ "$offenders" -gt 0 ]; then
  echo "" >&2
  echo "check-no-study-writes: found $offenders potential write(s) to study data." >&2
  echo "Study tables are read-only. Route codebook writes through cbFrom() (cb_* tables only)." >&2
  exit 1
fi

echo "check-no-study-writes: OK (no writes to study tables found)."
