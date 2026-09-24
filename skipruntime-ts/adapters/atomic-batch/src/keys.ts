/** Key and ordering helpers shared by both `AtomicSourceBatch` encodings. */

/** Throws if `entries` contains the same key twice. */
export function assertNoDuplicateKeys<K>(
  entries: readonly (readonly [K, ...unknown[]])[],
): void {
  const seen = new Set<K>();
  for (const [key] of entries) {
    if (seen.has(key)) {
      throw new Error(`duplicate key in batch: ${String(key)}`);
    }
    seen.add(key);
  }
}

/**
 * A namespaced key of the form `<component>/<table>/<id>`.
 *
 * Invariant: no segment may itself contain `/` (document IDs are external
 * data, so a `/` inside a segment would silently collide two keys).
 */
export function namespacedKey(
  component: string,
  table: string,
  id: string,
): string {
  for (const [name, segment] of [
    ["component", component],
    ["table", table],
    ["id", id],
  ] as const) {
    if (segment.includes("/")) {
      throw new Error(
        `namespacedKey: ${name} "${segment}" contains "/", which would collide with a different (component, table, id) triple`,
      );
    }
  }
  return `${component}/${table}/${id}`;
}

/** The fields the shared proof-vehicle contract orders rows by. */
export type OrderKey = {
  readonly creationTime: number;
  readonly id: string;
};

/**
 * Compares two order keys for descending `[_creationTime, _id]` order: the
 * later creation time sorts first, and equal creation times break ties by
 * descending `_id`.
 */
export function compareOrderKeyDesc(a: OrderKey, b: OrderKey): number {
  if (a.creationTime !== b.creationTime) {
    // Sign-based (not subtraction-based) comparison: `b - a` yields NaN when
    // either side is NaN, violating the `Array.sort` comparator contract.
    if (a.creationTime < b.creationTime) return 1;
    if (a.creationTime > b.creationTime) return -1;
    // Unordered pair, so NaN is involved: NaN sorts after every ordered
    // value so the result stays deterministic. NaN-vs-NaN falls through to
    // the `_id` tie-break below.
    if (Number.isNaN(a.creationTime) && !Number.isNaN(b.creationTime)) return 1;
    if (Number.isNaN(b.creationTime) && !Number.isNaN(a.creationTime))
      return -1;
  }
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}
