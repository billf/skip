import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    port: 3000,
    proxy: {
      "/skip-control": {
        target: "http://localhost:8081",
        rewrite: (path) => path.replace(/^\/skip-control/, ""),
      },
      "/skip-stream": {
        target: "http://localhost:8080",
        rewrite: (path) => path.replace(/^\/skip-stream/, ""),
      },
    },
  },
  plugins: [tanstackStart(), react()],
});
