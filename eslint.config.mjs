import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees (isolated checkouts under .claude/) — never lint them from
    // the main tree; each worktree lints itself. Without this, every error in
    // the main tree double-reports and in-flight agent branches break our lint.
    ".claude/**",
  ]),
]);

export default eslintConfig;
