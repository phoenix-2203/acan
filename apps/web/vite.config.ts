import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mirrors stellar/smart-account-kit's demo config: stellar-sdk needs
// `global` and a Buffer polyfill in the browser, and exactly one SDK copy.
export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  resolve: {
    dedupe: ["@stellar/stellar-sdk"],
  },
  build: { target: "es2022" },
  esbuild: { target: "es2022" },
  optimizeDeps: {
    esbuildOptions: { target: "es2022" },
    include: ["buffer", "@stellar/stellar-sdk", "@stellar/stellar-sdk/rpc"],
  },
  server: {
    // WebAuthn needs a secure context; "localhost" qualifies, 127.0.0.1 may not.
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
});
