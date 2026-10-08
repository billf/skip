import assert from "node:assert/strict";
import { test } from "node:test";

// M9 glob-collection proof: this file lives three segments deep
// (src/faults/glob-proof/deep/), beyond what an unquoted
// `src/**/*.test.ts` shell expansion reaches (the script shell expands
// `**` as `*` without globstar, matching exactly one segment). If the
// suite collects this test, the quoted recursive pattern is being
// resolved by the runner itself at every depth.
test("runner-resolved glob collects tests nested two-plus levels deep", () => {
  assert.equal(1 + 1, 2);
});
