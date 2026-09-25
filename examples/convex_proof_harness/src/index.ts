/**
 * Provisional correctness-comparator and fault-injection harness for the
 * shared Skip/Convex proof vehicle. See SPEC.md's sibling in
 * `@skip-adapter/atomic-batch` for the shared contract this harness proves
 * against (no harness README.md ships yet).
 *
 * @packageDocumentation
 */

export {
	CorpusSemanticHashError,
	EXPECTED_SEMANTIC_HASH,
	computeSemanticHash,
	loadCorpus,
	resolveExpectedFeed,
	resolveExpectedRow,
	type Corpus,
	type CorpusDelta,
	type CorpusOutRow,
	type CorpusVector,
	type FeedRow,
} from "./corpus.js";

export { compareFeeds, type Mismatch } from "./comparator.js";
