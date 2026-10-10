import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static site for GitHub Pages. `base: "./"` keeps asset URLs relative, so it
// works at https://<user>.github.io/<repo>/ without knowing the repo name.
export default defineConfig({
  base: "./",
  plugins: [react()],
  // The commit a build came from, shown in the app's footer (GitHub Actions sets GITHUB_SHA).
  define: { global: "globalThis", __BUILD__: JSON.stringify((process.env.GITHUB_SHA ?? "local").slice(0, 7)) },
  resolve: { dedupe: ["@stellar/stellar-sdk"] },
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
    include: ["buffer", "@stellar/stellar-sdk", "@stellar/stellar-sdk/rpc"],
  },
  // WebAuthn needs a secure context: "localhost" qualifies.
  server: { host: "localhost", port: 5174, strictPort: true },
  preview: { host: "localhost", port: 4174, strictPort: true },
});
