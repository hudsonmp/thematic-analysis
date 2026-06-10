import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack root to this repo. A stray `~/package-lock.json` above the
  // project causes Next 16 to infer the wrong workspace root and emit a
  // multiple-lockfile warning; `turbopack.root` (absolute path, per the Next
  // 16.2.6 docs at node_modules/next/dist/docs/.../next-config-js/turbopack.md)
  // overrides that inference.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
