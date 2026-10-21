import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: process.env.API_PROXY || "http://localhost:3000" },
      "/ws": {
        target: (process.env.API_PROXY || "http://localhost:3000").replace(
          "http",
          "ws",
        ),
        ws: true,
      },
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
