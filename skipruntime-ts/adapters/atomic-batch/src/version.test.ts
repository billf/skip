import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ATOMIC_BATCH_VERSION } from "./index.js";

test("ATOMIC_BATCH_VERSION matches package.json's version", () => {
  const packageJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "package.json",
  );
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version: string;
  };
  assert.equal(ATOMIC_BATCH_VERSION, version);
});
