import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
});
