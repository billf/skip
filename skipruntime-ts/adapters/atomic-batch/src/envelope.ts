/**
 * The revision envelope: the one wire shape a revision-delta source publishes and `SplitByTable` consumes.
 *
 * A revision is either an upsert, which carries its document, or a tombstone, which carries `null`. The union is
 * discriminated on `deleted`, so a typed caller cannot build `deleted: false` with a `null` doc (the applier still
 * validates untyped input at runtime). The same shape serves two phases, differing only in how `ts` is spelled:
 *
 * - `RevisionDeltaEntry<Doc>`: what a source *receives*; `ts` is a decimal string or a `bigint`.
 * - `RevisionEnvelope<Doc>`: what a source *publishes* to Skip and `SplitByTable` reads; `ts` is a canonical decimal
 *   string, because a published value must be JSON and a plain `number` loses precision above 2^53 (Convex
 *   timestamps are about 1.79e18).
 *
 * `toEnvelope` converts the first into the second; `envelopeDoc`, `unwrapEntry`, and `EnvelopeDoc` go back to the
 * document (`Envelope<T> -> T`).
 */

import type { Entry, Json } from "@skipruntime/core";

/** The fields every revision carries, parameterized by how its timestamp is spelled. */
type RevisionFields<Ts> = {
  readonly ts: Ts;
  readonly component: string;
  readonly table: string;
  readonly _id: string;
  readonly _creationTime: number;
};

/** An upsert carries its document; a tombstone carries `null`. */
type RevisionBody<Doc extends Json> =
  | { readonly deleted: false; readonly doc: Doc }
  | { readonly deleted: true; readonly doc: null };

/** One revision with a caller-chosen timestamp spelling. */
export type Revision<Doc extends Json, Ts> = RevisionFields<Ts> &
  RevisionBody<Doc>;

/** The decimal-string or `bigint` spellings of a revision timestamp accepted on input. */
export type RevisionTs = string | bigint;

/** A revision as a source receives it. */
export type RevisionDeltaEntry<Doc extends Json> = Revision<Doc, RevisionTs>;

/** A revision as it is published to Skip and read by `SplitByTable`: JSON, with a canonical decimal-string `ts`. */
export type RevisionEnvelope<Doc extends Json = Json> = Revision<Doc, string>;

/** `Envelope<T> -> T`: the document type an envelope (or a union of envelopes) carries. */
export type EnvelopeDoc<E> = E extends { readonly doc: infer D }
  ? Exclude<D, null>
  : never;

/** The `[key, envelopes[]]` entries a source publishes: one envelope per upsert, an empty array per tombstone. */
export type RevisionChange<Doc extends Json> = Entry<
  string,
  RevisionEnvelope<Doc>
>;

// Compile-time guarantee: an envelope is a valid Skip value (and so a valid `SplitByTable` input), for any JSON doc.
// If a field is added that is not JSON, this stops compiling instead of failing at runtime inside Skip.
type AssertJson<T extends Json> = T;
export type EnvelopeIsJson = AssertJson<RevisionEnvelope<Json>>;

const DECIMAL = /^[0-9]+$/;

/** Parses a revision timestamp to `bigint`, rejecting malformed input with a clear `Error` (never a raw `SyntaxError`). */
export function toBigInt(ts: RevisionTs, context: string): bigint {
  if (typeof ts === "bigint") return ts;
  // `BigInt` alone would accept "", whitespace-padded, hex, and signed strings (as 0, 12, 16, ...).
  if (!DECIMAL.test(ts)) {
    throw new Error(
      `invalid revision timestamp ${context}: ${JSON.stringify(ts)} (expected a decimal integer string or bigint)`,
    );
  }
  return BigInt(ts);
}

/** Compares two revision timestamps exactly, regardless of magnitude (both convert through `BigInt`). Throws an `Error` on malformed input. */
export function compareTs(a: RevisionTs, b: RevisionTs): number {
  const ai = toBigInt(a, "in compareTs(a)");
  const bi = toBigInt(b, "in compareTs(b)");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** True when `value` has the envelope's discriminating fields (`deleted` and `ts`), which a snapshot `TaggedRow` lacks. */
export function isRevisionEnvelope(
  value: object,
): value is RevisionEnvelope<Json> {
  return "deleted" in value && "ts" in value;
}

/**
 * `RevisionDeltaEntry<Doc> -> RevisionEnvelope<Doc>`: validates and canonicalizes `ts` (so `"007"`, `7n`, and `"7"`
 * publish identically) and returns a fresh object. Throws on a malformed `ts`, naming `context`.
 */
export function toEnvelope<Doc extends Json>(
  entry: RevisionDeltaEntry<Doc>,
  context = `for _id "${entry._id}"`,
): RevisionEnvelope<Doc> {
  const ts = toBigInt(entry.ts, context).toString();
  const base = {
    ts,
    component: entry.component,
    table: entry.table,
    _id: entry._id,
    _creationTime: entry._creationTime,
  };
  return entry.deleted
    ? { ...base, deleted: true, doc: null }
    : { ...base, deleted: false, doc: entry.doc };
}

/** `RevisionEnvelope<Doc> -> Doc | null`: the document, or `null` for a tombstone. */
export function envelopeDoc<Doc extends Json>(
  envelope: RevisionEnvelope<Doc>,
): Doc | null {
  return envelope.doc;
}

/** Unwraps a published `[key, envelopes[]]` entry to `[key, docs[]]`; a tombstone's empty array stays empty. */
export function unwrapEntry<Doc extends Json>(
  entry: RevisionChange<Doc>,
): Entry<string, Doc> {
  const [key, envelopes] = entry;
  return [
    key,
    envelopes.flatMap((envelope) => (envelope.deleted ? [] : [envelope.doc])),
  ];
}
