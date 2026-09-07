import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // DEVELOPMENT ONLY -- DO NOT COPY THIS INTO A DEPLOYMENT.
      //
      // Port 8081 is Skip's *control* API. Besides the two stream-lifecycle
      // routes this demo needs (POST /v1/streams/:resource and
      // DELETE /v1/streams/:uuid) it also serves POST /v1/snapshot/:resource
      // and PATCH /v1/inputs/:collection -- a write route. It has no
      // authentication, because it is meant to sit behind infrastructure that
      // does. This blanket prefix strip forwards all of it to the page, which
      // is harmless against a localhost listener and inexcusable behind a
      // public origin: every visitor could write to input collections and read
      // any resource by name. CORS does not help; it constrains cooperative
      // pages, not direct requests.
      //
      // In production expose only the streaming port's GET /v1/streams/:uuid,
      // and mint stream UUIDs from your own authenticated server-side endpoint.
      // See DESIGN.md, "The Skip control API is not a browser-facing surface",
      // and examples/hackernews for a worked gateway split.
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
