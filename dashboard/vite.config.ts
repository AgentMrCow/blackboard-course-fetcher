import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

const dashboardRoot = path.resolve(__dirname, "client");

export default defineConfig({
  root: dashboardRoot,
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "public"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => assetInfo.names?.some((name) => name.endsWith(".css"))
          ? "assets/styles.css"
          : "assets/[name][extname]",
      },
    },
  },
});
