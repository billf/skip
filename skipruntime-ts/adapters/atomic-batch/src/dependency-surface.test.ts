import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Covers AE10: this package imports only @skipruntime/core's exported
// surface (any of its exports-map entries, including the naming-convention
// "internal" ones -- narrowing further would mean enumerating specific
// subpaths here).
// Covers AE8 (P half): this package imports nothing from any spike package
// (adapters/convex, examples/convex_data_sync_push) or from Q
// (examples/convex_proof_harness), including via a relative path that
// escapes this package's own directory, a dynamic import(), or an
// `export * as ns from` re-export.

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(srcDir, "..");

const IMPORT_SOURCE_RE =
  /^\s*import\s+(?:type\s+)?(?:[^"'()]+?from\s+)?["']([^"']+)["']/gm;
const EXPORT_FROM_RE =
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

function importsIn(text: string): string[] {
  const specs: string[] = [];
  for (const re of [IMPORT_SOURCE_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
    for (const m of text.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

const FORBIDDEN_SUBSTRINGS = [
  "adapters/convex",
  "convex_data_sync_push",
  "convex_proof_harness",
  "skip-convex-proof-harness",
];

function assertNotForbidden(file: string, spec: string, checked: string): void {
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    assert.ok(
      !checked.includes(forbidden),
      `${file}: import "${spec}" reaches into a spike package or Q ("${forbidden}")`,
    );
  }
}

test("imports only @skipruntime/core (or relative/node builtins), never a spike package or Q", () => {
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const spec of importsIn(text)) {
      const isRelative = spec.startsWith(".") || spec.startsWith("/");
      const isNodeBuiltin = spec.startsWith("node:");
      const isCore =
        spec === "@skipruntime/core" || spec.startsWith("@skipruntime/core/");
      assert.ok(
        isRelative || isNodeBuiltin || isCore,
        `${file}: import "${spec}" is not @skipruntime/core, relative, or a node builtin`,
      );
      assertNotForbidden(file, spec, spec);
      if (isRelative) {
        const resolved = resolve(dirname(file), spec);
        const rel = relative(packageRoot, resolved);
        assert.ok(
          rel === "" || !rel.startsWith(".."),
          `${file}: relative import "${spec}" escapes the package root (resolves to ${resolved})`,
        );
        assertNotForbidden(file, spec, resolved);
      }
    }
  }
});
