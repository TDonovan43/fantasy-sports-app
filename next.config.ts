import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The HiGHS lineup solver is a WebAssembly build: load it with Node's own require (not bundled)
  // and ship its .wasm file with the optimize route.
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: {
    "/api/optimize": ["./node_modules/highs/build/**/*"],
  },
};

export default nextConfig;
