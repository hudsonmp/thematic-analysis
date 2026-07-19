#!/usr/bin/env bash
# check-no-study-writes.sh
#
# Defense-in-depth lint guard. The service-role key bypasses RLS, so the only
# thing standing between this app and a mutation of IRB-covered study data is
# discipline. `cbFrom()` enforces this at runtime (see lib/supabase/guard.ts),
# `studyFrom()` enforces SELECT-only study reads (lib/supabase/study-guard.ts);
# this script enforces the same boundaries at lint time with three rules:
#
#   Rule 1 — no write verb chained to a study table. Greps app/, lib/, and
#     components/ for a study-table `.from(...)` and, if a write verb
#     (.insert/.update/.delete/.upsert) appears on the same line OR within the
#     next few lines (a chained call), fails with file:line of the offending
#     `.from`. Conservative / false-positive-safe: it only fires when BOTH a
#     study-table `.from(` AND a write verb are present in the same small
#     window. Read-only `.from('studies').select(...)` never trips it.
#
#   Rule 2 — the service-role client is QUARANTINED. Only an explicit allowlist
#     of sanctioned modules may call `createServiceRoleClient(`; everything else
#     must go through cbFrom (writes, cb_ tables) or studyFrom (study reads on
#     the user client).
#
#   Rule 3 — no `.rpc()` anywhere in app code: stored procedures bypass both
#     the cbFrom and studyFrom guards entirely.
#
# Excludes node_modules, and (Rule 1 only) the client modules that construct
# the study-reading clients (lib/supabase/server.ts, lib/supabase/service.ts).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Study tables that are read-only for this app.
STUDY_FROM_RE="from\((['\"])(studies|study_events|study_snapshots|study_responses|study_scripts|study_assistant_messages|users|onboarding|llm_prompts)"
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
  find app lib components -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null \
    | grep -v '/node_modules/' \
    | grep -v -E '^lib/supabase/(server|service)\.ts$' \
    | sort
)

# --- Rule 2: the service-role client is QUARANTINED. Only the guard modules may
# construct it; study reads go through studyFrom (user client, SELECT-only RLS),
# cb_ writes through cbFrom. The allowlist below names every sanctioned site:
# guard/service modules, the Auth-admin call (app/actions/auth.ts), cb_-only
# readers, and the storage/media route. Adding a site here is a deliberate,
# reviewed act.
#
# NOTE on the cb_-only readers: app/actions/codebook.ts and app/actions/memos.ts
# read cb_ tables directly on the service client. That is legacy-sanctioned —
# they predate the guards and touch only cb_ tables — but migrating them to
# cbFrom-style access or the user client would let this allowlist shrink.
# Path-ANCHORED (`^`): grep emits repo-relative paths with no leading `./`, so
# a suffix match would silently sanction e.g. components/lib/supabase/guard.ts.
SERVICE_ALLOWLIST_RE='^lib/supabase/(guard|service|study-guard)\.ts$|^app/actions/(auth|codebook|memos)\.ts$|^app/api/media/'
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file="${hit%%:*}"
  if printf '%s' "$file" | grep -qE "$SERVICE_ALLOWLIST_RE"; then continue; fi
  echo "ERROR: raw createServiceRoleClient outside the sanctioned allowlist: $hit" >&2
  offenders=$((offenders + 1))
done < <(
  grep -rn "createServiceRoleClient(" app lib components \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)

# --- Rule 3: no .rpc() anywhere in app code (stored procedures bypass both
# guards). Comment-only mentions are skipped in two stages: the guard modules
# document in prose that `.rpc()` is NOT intercepted, and file-allowlisting
# them would instead permit a real `.rpc(` call in exactly the modules that
# hold the service client. Add a deliberate allowlist entry here if a real
# call site is ever needed.
#
# Deliberate allowlist (pair-scoped: procedure name AND file must both match,
# so neither a new procedure in codes.ts nor cb_merge_codes from elsewhere
# slips through): `cb_merge_codes` is a SECURITY INVOKER function over cb_
# tables only, called on the ANON user client (mergeCodes, app/actions/codes.ts)
# — RLS enforces editorship at the DB, so the guards it "bypasses" are
# re-imposed by Postgres itself.
RPC_ALLOWED_FILE_RE='^app/actions/codes\.ts$'
RPC_ALLOWED_NAME_RE="\.rpc\('cb_merge_codes'"
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file="${hit%%:*}"
  # Line content after `path:lineno:` (repo paths contain no colons).
  content="${hit#*:}"
  content="${content#*:}"
  if printf '%s' "$file" | grep -qE "$RPC_ALLOWED_FILE_RE" \
    && printf '%s' "$content" | grep -qE "$RPC_ALLOWED_NAME_RE"; then continue; fi
  # Stage (i): skip ONLY comment-to-EOL prefixes — `//`, or a block-comment
  # continuation `*` FOLLOWED BY whitespace/EOL. A bare `*/` or `/*` prefix
  # does NOT qualify: code may follow the delimiter on the same line
  # (`/* c */ await sb.rpc('x')`), and generator methods (`*gen(`) must not
  # hide either.
  if printf '%s' "$content" | grep -qE '^[[:space:]]*(//|\*([[:space:]]|$))'; then continue; fi
  # Stage (ii): strip a leading `*/` and every CLOSED `/* ... */` span, then
  # flag only if `.rpc(` survives the strip. Residual false positive — an
  # unclosed `/*` opened on this line whose prose mentions `.rpc(` — fails
  # SAFE (flagged for a human), the right direction for this guard.
  stripped="$(printf '%s' "$content" | sed -E 's#^[[:space:]]*\*/##; s#/\*([^*]|\*+[^*/])*\*+/##g')"
  if ! printf '%s' "$stripped" | grep -qE '\.rpc\('; then continue; fi
  echo "ERROR: .rpc( call (bypasses cbFrom/studyFrom guards): $hit" >&2
  offenders=$((offenders + 1))
done < <(
  grep -rn "\.rpc(" app lib components --include='*.ts' --include='*.tsx' 2>/dev/null || true
)

if [ "$offenders" -gt 0 ]; then
  echo "" >&2
  echo "check-no-study-writes: found $offenders guard violation(s)." >&2
  echo "Study tables are read-only (reads via studyFrom). Route codebook writes through cbFrom() (cb_* tables only)." >&2
  exit 1
fi

echo "check-no-study-writes: OK (no study-table writes, no raw service client, no .rpc)."
