/**
 * Shared structural-equality helper for the proof harness (comparator,
 * observer, schema validation). Single copy on purpose: the three call
 * sites previously carried near-duplicate implementations whose
 * null/undefined handling had already started to drift.
 *
 * Semantics (pinned, do not "improve" casually): `Object.is` is NOT used,
 * so `NaN` is unequal to itself; `undefined` and `null` are unequal to
 * everything including each other; arrays compare by numeric-index keys
 * with no prototype or undefined-vs-missing distinction. Adequate for the
 * flat JSON shapes in scope; revisit if nested or exotic shapes arrive.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined)
    return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}
