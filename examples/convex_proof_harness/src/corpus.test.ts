import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CorpusSemanticHashError,
	computeSemanticHash,
	loadCorpus,
	parseCorpus,
	resolveExpectedRow,
	type Corpus,
} from "./corpus.js";
import { HarnessError } from "./readiness.js";

test("loadCorpus verifies the vendored corpus's semantic hash and returns V1-V6", () => {
	const corpus = loadCorpus();
	assert.equal(corpus.fixtureSetVersion, "1.0.0");
	assert.deepEqual(Object.keys(corpus.vectors), ["V1", "V2", "V3", "V4", "V5", "V6"]);
});

test("the cached corpus is deep-frozen: in-place mutation throws instead of corrupting later readers", () => {
	const corpus = loadCorpus();
	assert.ok(Object.isFrozen(corpus));
	assert.throws(() => {
		(corpus as unknown as Record<string, unknown>)["fixtureSetVersion"] = "tampered";
	}, TypeError);
	assert.equal(loadCorpus().fixtureSetVersion, "1.0.0");
});

test("parseCorpus rejects non-JSON text with a HarnessError naming the source", () => {
	assert.throws(() => parseCorpus("not json{", "test-source"), HarnessError);
});

test("parseCorpus rejects a well-formed non-corpus shape with a HarnessError", () => {
	assert.throws(() => parseCorpus(JSON.stringify([1, 2, 3]), "test-source"), HarnessError);
	assert.throws(() => parseCorpus(JSON.stringify({ fixtureSetVersion: 42 }), "test-source"), HarnessError);
});

test("a reformatted corpus (same content, different whitespace) passes", () => {
	const corpus = loadCorpus();
	// Pretty-printing changes only whitespace, not content or key order.
	const reformatted = JSON.parse(JSON.stringify(corpus, null, 4)) as Corpus;
	assert.equal(computeSemanticHash(reformatted), computeSemanticHash(corpus));
});

test("a corpus with a different top-level key order (same content) passes", () => {
	const corpus = loadCorpus();
	// Same fields as the loaded corpus, inserted in reverse key order.
	const reordered = Object.fromEntries(
		Object.entries(corpus).reverse(),
	) as unknown as Corpus;
	assert.equal(computeSemanticHash(reordered), computeSemanticHash(corpus));
});

test("a corpus with reordered nested keys (same content) passes", () => {
	const corpus = loadCorpus();
	// Reverse key order one level down too: canonicalize sorts nested
	// object keys recursively, so nested reorder must not change the hash.
	const reordered = Object.fromEntries(
		Object.entries(corpus).reverse().map(([k, v]) => [
			k,
			v !== null && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.entries(v).reverse())
				: v,
		]),
	) as unknown as Corpus;
	assert.equal(computeSemanticHash(reordered), computeSemanticHash(corpus));
});

test("a semantically changed corpus fails the semantic-hash check", () => {
	const corpus = loadCorpus();
	const mutated: Corpus = JSON.parse(JSON.stringify(corpus)) as Corpus;
	mutated.vectors["V1"]!.expectedBase[0]!.likeCount = 99;
	assert.notEqual(computeSemanticHash(mutated), computeSemanticHash(corpus));
});

test("CorpusSemanticHashError names both hashes", () => {
	const error = new CorpusSemanticHashError("actual-hash", "expected-hash");
	assert.match(error.message, /actual-hash/);
	assert.match(error.message, /expected-hash/);
});

test("resolveExpectedRow throws on an unbound label", () => {
	assert.throws(
		() =>
			resolveExpectedRow(
				{ id: "missing", creationTime: 1, room: "r", body: "x", sender: null, likeCount: 0 },
				new Map(),
			),
		/unbound label/,
	);
});
