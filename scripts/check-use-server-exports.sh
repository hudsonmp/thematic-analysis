#!/usr/bin/env bash
# check-use-server-exports — a 'use server' module may export ONLY async functions.
#
# The trap this pins: `export type { Foo }` — RE-exporting a type that was imported
# from another module. `tsc` erases it and reports nothing, but the server-action
# transform cannot prove across a module boundary that the symbol is type-only, so
# it emits a server reference for a name with no runtime value and the Turbopack
# build dies with "Export Foo doesn't exist in target module".
#
# `tsc --noEmit` is structurally blind to this (it is a BUNDLER contract, not a type
# contract), and it broke main once already. Hence a grep guard in the lint chain
# rather than a note in a doc.
#
# Locally DECLARED types (`export type Foo = { ... }`) are fine: SWC sees the
# declaration and erases it. Only the brace-list re-export form is flagged.
set -euo pipefail

fail=0

# Every file whose FIRST line is the 'use server' directive.
while IFS= read -r file; do
  head -1 "$file" | grep -qE "^['\"]use server['\"]" || continue

  # `export type { ... }` or `export { type Foo }` — the re-export forms.
  if grep -nE "^\s*export\s+type\s*\{|^\s*export\s*\{[^}]*\btype\b" "$file"; then
    echo "  ^-- in $file"
    echo "      A 'use server' module may export only async functions. Move the type to"
    echo "      a pure module and have consumers import it from there."
    fail=1
  fi
done < <(find app lib components -name '*.ts' -o -name '*.tsx' 2>/dev/null)

if [ "$fail" -ne 0 ]; then
  echo "check-use-server-exports: FAILED — type re-export from a 'use server' module."
  exit 1
fi

echo "check-use-server-exports: OK (no type re-exports from 'use server' modules)."
