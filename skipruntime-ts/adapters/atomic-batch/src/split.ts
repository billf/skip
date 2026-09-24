/**
 * Split mappers that project a combined collection into per-table
 * collections, serving both `AtomicSourceBatch` encodings.
 */

import type { Context, Json, Mapper, Values } from "@skipruntime/core";
import { namespacedKey } from "./keys.js";

/** One row of a `SnapshotBatch` query's value list, tagged with its table. */
export type TaggedRow = {
  readonly table: string;
  readonly doc: Json;
};

/** One row of a `RevisionDeltaBatch`, carrying its own table tag and tombstone flag. */
export type RevisionEnvelope = {
  readonly ts: string | number;
  readonly deleted: boolean;
  readonly component: string;
  readonly table: string;
  readonly _id: string;
  readonly _creationTime: number;
  readonly doc: Json;
};

/** The harness-only marker row's table name; it is routed to the control collection. */
export const MARKER_TABLE = "marker";

/** The component name the split mapper routes `marker` rows to. */
export const CONTROL_COMPONENT = "control";

function docId(table: string, key: string, doc: Json): string {
  if (
    doc !== null &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    typeof (doc as { _id?: unknown })._id === "string"
  ) {
    return (doc as { _id: string })._id;
  }
  throw new Error(
    `split: table "${table}" key "${key}" has a row missing a string _id`,
  );
}

/**
 * True when a split-input value is a `RevisionDeltaBatch` envelope rather
 * than a snapshot `TaggedRow`. The envelope's `deleted`/`ts` fields are
 * absent from `TaggedRow`, so their joint presence discriminates the union.
 */
function isRevisionEnvelope(
  value: TaggedRow | RevisionEnvelope,
): value is RevisionEnvelope {
  return "deleted" in value && "ts" in value;
}

/**
 * Projects one combined-collection entry into `<component>/<table>/<id>`
 * keyed per-table rows. Each input value is one row: either a
 * `SnapshotBatch` query's `TaggedRow` (one value per row, matching the
 * `Entry<K, V> = [K, V[]]` multiplicity `snapshot.ts` publishes) or a single
 * `RevisionDeltaBatch` envelope; either way the output shape is the same, so
 * one mapper serves both encodings. Rejects any row whose table is not in
 * `knownTables` (and is not the harness-only marker table) with an error.
 */
export class SplitByTable
  implements Mapper<string, TaggedRow | RevisionEnvelope, string, Json>
{
  /**
   * @param component The component whose rows this mapper splits; snapshot
   * rows carry no component tag, so their output keys always use this value.
   * @param knownTables Tables accepted besides the harness-only marker
   * table. When wiring through `EagerCollection.map`, pass
   * `deepFreeze(knownTables)`: mapper constructor params must be `DepSafe`,
   * and a plain `Set` only satisfies that bound once deep-frozen.
   */
  constructor(
    private readonly component: string,
    private readonly knownTables: ReadonlySet<string>,
  ) {}

  mapEntry(
    _key: string,
    values: Values<TaggedRow | RevisionEnvelope>,
    _context: Context,
  ): Iterable<[string, Json]> {
    const out: [string, Json][] = [];
    for (const value of values) {
      const envelope = isRevisionEnvelope(value) ? value : null;
      const isMarker = value.table === MARKER_TABLE;
      if (
        envelope !== null &&
        !isMarker &&
        envelope.component !== this.component
      ) {
        throw new Error(
          `split: revision envelope for component "${envelope.component}" does not match mapper component "${this.component}"`,
        );
      }
      if (!isMarker && !this.knownTables.has(value.table)) {
        throw new Error(`split: unknown table "${value.table}"`);
      }
      if (envelope?.deleted) continue;
      const component = isMarker ? CONTROL_COMPONENT : this.component;
      out.push([
        namespacedKey(
          component,
          value.table,
          docId(value.table, _key, value.doc),
        ),
        value.doc,
      ]);
    }
    return out;
  }
}
