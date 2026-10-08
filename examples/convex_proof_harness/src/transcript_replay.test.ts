import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SseReader, type Entry } from "./sse_reader.js";

/**
 * The recorded SSE transcripts (`testdata/sse/*.jsonl`) are written from
 * already-parsed callback events, so nothing else ever feeds them back
 * through the raw-byte path. This replays each one as SSE wire bytes with
 * adversarial chunking and checks the decoded sequence round-trips, so a
 * framing or heartbeat regression turns these tests red.
 */

const SSE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "testdata",
  "sse",
);

type Recorded = { event: string; id?: string; data: unknown };

type Decoded =
  | { kind: "init" | "update"; watermark: string; values: readonly Entry[] }
  | { kind: "checkpoint"; version: number }
  | { kind: "heartbeat" };

function transcripts(): { name: string; records: Recorded[] }[] {
  return readdirSync(SSE_DIR)
    .filter((name) => /^V\d+-.*\.jsonl$/.test(name))
    .sort()
    .map((name) => ({
      name,
      records: readFileSync(join(SSE_DIR, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Recorded),
    }));
}

function toWire(record: Recorded, eol: string): string {
  const lines = [`event: ${record.event}`];
  if (record.id !== undefined) lines.push(`id: ${record.id}`);
  lines.push(`data: ${JSON.stringify(record.data)}`);
  return lines.join(eol) + eol + eol;
}

function expectedFor(record: Recorded): Decoded {
  if (record.event === "checkpoint") {
    return {
      kind: "checkpoint",
      version: (record.data as { version: number }).version,
    };
  }
  assert.ok(record.event === "init" || record.event === "update");
  return {
    kind: record.event,
    watermark: record.id!,
    values: record.data as Entry[],
  };
}

function decode(wire: string, chunkSize: number): Decoded[] {
  const out: Decoded[] = [];
  const reader = new SseReader("http://127.0.0.1:9/v1/streams/replay", {
    onInit: (watermark, values) =>
      out.push({ kind: "init", watermark, values }),
    onUpdate: (watermark, values) =>
      out.push({ kind: "update", watermark, values }),
    onCheckpoint: (version) => out.push({ kind: "checkpoint", version }),
    onHeartbeat: () => out.push({ kind: "heartbeat" }),
  });
  for (let i = 0; i < wire.length; i += chunkSize) {
    reader.push(wire.slice(i, i + chunkSize));
  }
  return out;
}

test("there are recorded transcripts to replay", () => {
  assert.ok(transcripts().length > 0);
});

test("every recorded transcript round-trips through the raw-byte reader under adversarial chunking", () => {
  for (const { name, records } of transcripts()) {
    const expected = records.map(expectedFor);
    const wire = records.map((record) => toWire(record, "\n")).join("");
    for (const chunkSize of [1, 3, 7, 64, wire.length]) {
      assert.deepEqual(
        decode(wire, chunkSize),
        expected,
        `${name} diverged at chunk size ${chunkSize}`,
      );
    }
  }
});

test("a CRLF-framed replay decodes identically when chunks do not split a CRLF pair", () => {
  for (const { name, records } of transcripts()) {
    const expected = records.map(expectedFor);
    const wire = records.map((record) => toWire(record, "\r\n")).join("");
    // Chunk on whole lines: the splitter normalizes CRLF per chunk, so a
    // pair split across two chunks is a separate, known limitation.
    const lines = wire.match(/[^\n]*\n/g) ?? [];
    const singleChunk = decode(lines.join(""), wire.length);
    assert.deepEqual(singleChunk, expected, `${name} (CRLF, single chunk)`);
    let at = 0;
    const out: Decoded[] = [];
    const chunked = new SseReader("http://127.0.0.1:9/v1/streams/replay", {
      onInit: (watermark, values) =>
        out.push({ kind: "init", watermark, values }),
      onUpdate: (watermark, values) =>
        out.push({ kind: "update", watermark, values }),
      onCheckpoint: (version) => out.push({ kind: "checkpoint", version }),
    });
    while (at < lines.length) {
      chunked.push(lines.slice(at, at + 2).join(""));
      at += 2;
    }
    assert.deepEqual(out, expected, `${name} (CRLF, two lines per chunk)`);
  }
});

test("heartbeats interleaved between recorded frames are surfaced and never disturb the data events", () => {
  for (const { name, records } of transcripts()) {
    // Both heartbeat spellings: Skip's `data:[]` and a bare empty `data:`.
    const heartbeats = [
      "event: update\ndata:[]\n\n",
      "event: update\ndata:\n\n",
    ];
    const wire = records
      .map(
        (record, i) =>
          heartbeats[i % heartbeats.length]! + toWire(record, "\n"),
      )
      .join("");
    const decoded = decode(wire, 5);
    assert.equal(
      decoded.filter((event) => event.kind === "heartbeat").length,
      records.length,
      `${name}: one heartbeat per injected frame`,
    );
    assert.deepEqual(
      decoded.filter((event) => event.kind !== "heartbeat"),
      records.map(expectedFor),
      `${name}: data events unchanged by heartbeats`,
    );
  }
});
