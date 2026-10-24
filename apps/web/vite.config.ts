/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only API target. In production the Worker serves these same static assets and
// the /api routes from one origin, so no proxy (and no cross-origin CSRF) applies.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.API_TARGET ?? "http://localhost:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Ships without maps: the asset binding serves whatever is in dist, and a public
    // .map of a private app is source disclosure for nobody's benefit.
    sourcemap: false,
    rollupOptions: {
      output: {
        // React changes rarely and app code does; keeping them apart means an ordinary
        // deploy re-downloads only the app half of the bundle.
        manualChunks: { react: ["react", "react-dom"] },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
