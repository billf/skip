import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Covers AE8 (Q half): this package imports nothing from any spike package
// (adapters/convex, examples/convex_data_sync_push) -- Q's own tests may
// depend on convex-tutorial's vendored corpus/parity *data*, but never on
// spike *code*, so unlike the first version of this guard the scan covers
// *.test.ts files too (a test importing spike code would otherwise go
// undetected). Relative imports must stay inside this package's own
// directory: a relative specifier that resolves outside the package root --
// or into a forbidden directory without the literal substring appearing in
// the specifier text -- is rejected. Approach ported from
// skipruntime-ts/adapters/atomic-batch/src/dependency-surface.test.ts.

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(srcDir, "..");

const IMPORT_SOURCE_RE =
  /^\s*import\s+(?:type\s+)?(?:[^"'()]+?from\s+)?["']([^"']+)["']/gm;
const EXPORT_FROM_RE =
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gm;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function importsIn(text: string): string[] {
  const specs: string[] = [];
  for (const re of [
    IMPORT_SOURCE_RE,
    EXPORT_FROM_RE,
    DYNAMIC_IMPORT_RE,
    REQUIRE_RE,
  ]) {
    for (const m of text.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

const FORBIDDEN_SUBSTRINGS = ["adapters/convex", "convex_data_sync_push"];

function forbiddenViolations(
  file: string,
  spec: string,
  checked: string,
): string[] {
  const violations: string[] = [];
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    if (checked.includes(forbidden)) {
      violations.push(
        `${file}: import "${spec}" reaches into a spike package ("${forbidden}")`,
      );
    }
  }
  return violations;
}

/**
 * Every boundary violation for one (file, specifier) pair (empty means
 * clean). Shared by the live tree scan below and the seeded cases that
 * follow, so a seeded case passing here is the guard itself failing to
 * flag it.
 */
function violationsFor(file: string, spec: string): string[] {
  const violations: string[] = [];
  const isRelative = spec.startsWith(".") || spec.startsWith("/");
  const isNodeBuiltin = spec.startsWith("node:");
  const isCore =
    spec === "@skipruntime/core" || spec.startsWith("@skipruntime/core/");
  if (!isRelative && !isNodeBuiltin && !isCore) {
    violations.push(
      `${file}: import "${spec}" is not @skipruntime/core, relative, or a node builtin`,
    );
  }
  violations.push(...forbiddenViolations(file, spec, spec));
  if (isRelative) {
    const resolved = resolve(dirname(file), spec);
    const rel = relative(packageRoot, resolved);
    if (rel === "" || rel.startsWith("..")) {
      violations.push(
        `${file}: relative import "${spec}" escapes the package root (resolves to ${resolved})`,
      );
    }
    violations.push(...forbiddenViolations(file, spec, resolved));
  }
  return violations;
}

test("Q imports no spike package", () => {
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const spec of importsIn(text)) {
      assert.deepEqual(
        violationsFor(file, spec),
        [],
        `${file}: import "${spec}"`,
      );
    }
  }
});

test("the guard scans test files too", () => {
  assert.ok(
    sourceFiles(srcDir).some((f) => f.endsWith(".test.ts")),
    "expected the scan to include *.test.ts files",
  );
  // A forbidden import gets no exemption for living in a test file.
  const spike = ["adapters", "convex", "foo.js"].join("/");
  assert.ok(violationsFor(join(srcDir, "seeded.test.ts"), spike).length > 0);
});

test("the guard flags a static forbidden import", () => {
  const spike = ["adapters", "convex", "foo.js"].join("/");
  assert.deepEqual(importsIn(`import { x } from "${spike}";`), [spike]);
  assert.ok(violationsFor(join(srcDir, "seeded.ts"), spike).length > 0);
  assert.deepEqual(importsIn('export * as ns from "some-pkg/x.js";'), [
    "some-pkg/x.js",
  ]);
});

test("the guard extracts and flags dynamic import() and require() specifiers", () => {
  const spike = ["adapters", "convex", "foo.js"].join("/");
  // Built via interpolation so this file's own text never contains an
  // import("...")/require("...") call the live scan above could match --
  // only the runtime string does.
  const quoted = `"${spike}"`;
  const dynamicSnippet = `const mod = await import(${quoted});`;
  const requireSnippet = `const mod = require(${quoted});`;
  assert.deepEqual(importsIn(dynamicSnippet), [spike]);
  assert.deepEqual(importsIn(requireSnippet), [spike]);
  for (const spec of [
    ...importsIn(dynamicSnippet),
    ...importsIn(requireSnippet),
  ]) {
    assert.ok(violationsFor(join(srcDir, "seeded.ts"), spec).length > 0, spec);
  }
});

test("the guard flags a relative import that escapes the package root", () => {
  // No forbidden substring in the specifier text -- the escape check alone
  // must catch it.
  const file = join(srcDir, "faults", "seeded.ts");
  const violations = violationsFor(file, "../../../elsewhere/evil.js");
  assert.ok(
    violations.some((v) => v.includes("escapes the package root")),
    JSON.stringify(violations),
  );
});

test("the guard accepts in-root relative, node builtins, and @skipruntime/core", () => {
  assert.deepEqual(
    violationsFor(join(srcDir, "seeded.ts"), "./comparator.js"),
    [],
  );
  assert.deepEqual(
    violationsFor(join(srcDir, "faults", "seeded.ts"), "../readiness.js"),
    [],
  );
  assert.deepEqual(
    violationsFor(join(srcDir, "seeded.ts"), "node:assert/strict"),
    [],
  );
  assert.deepEqual(
    violationsFor(join(srcDir, "seeded.ts"), "@skipruntime/core"),
    [],
  );
});
