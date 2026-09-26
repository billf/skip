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

export {
	CATALOG,
	DIRECTION_TAGGED_METRICS,
	lookupMetric,
	requirementFor,
	requiredMetricsFor,
	type Direction,
	type MetricCatalogEntry,
	type MetricKind,
	type MetricRequirement,
} from "./catalog.js";

export { CheckpointEmitter, formatCheckpointFrame, type CheckpointSink } from "./checkpoint.js";

export {
	HarnessError,
	QuiescedWriteCoordinator,
	ReadinessDetector,
	type Discipline,
	type Gate1Event,
	type Gate2Event,
} from "./readiness.js";

export {
	Recorder,
	type CheckpointRecord,
	type FreshnessDisposition,
	type MetricSample,
} from "./recorder.js";
