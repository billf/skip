import { config } from "dotenv";
import { runService } from "@skipruntime/server";
import { createService } from "./service.js";

config({ path: ".env.local" });
const convexUrl = process.env["VITE_CONVEX_URL"];
if (convexUrl === undefined || convexUrl.length === 0) {
  throw new Error("VITE_CONVEX_URL is missing; run `npx convex dev` first");
}

await runService(createService(convexUrl));
