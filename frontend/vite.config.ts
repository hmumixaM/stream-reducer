import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split only the app-wide core libs into a long-lived vendor chunk.
        // Page-local heavyweights (recharts, react-markdown, force-graph) are
        // intentionally left out so they stay in their own lazy route chunks.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|@remix-run|@tanstack|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-react";
          }
        },
      },
    },
  },
});
