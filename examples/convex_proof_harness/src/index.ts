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

export {
  CheckpointEmitter,
  formatCheckpointFrame,
  type CheckpointSink,
} from "./checkpoint.js";

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

export {
  SseParseError,
  SseFrameSplitter,
  SseReader,
  assertLoopbackUrl,
  classifyFrame,
  type Entry,
  type SseEvent,
  type SseRawFrame,
  type SseReaderCallbacks,
} from "./sse_reader.js";

export {
  NativeReader,
  admitNativeSample,
  type NativeReadAdmission,
  type NativeReadResult,
  type OneShotReader,
} from "./native_reader.js";

export {
  EXPECTED_FIXTURE_SET_VERSION,
  PARITY_HASH_ALGORITHM,
  assertParityMatch,
  computeParity,
  loadVendoredParity,
  type TableParity,
  type VendoredParity,
} from "./parity.js";

export {
  NoTornObserver,
  extractWatchedValue,
  type TornObservation,
  type WatchedGroup,
} from "./observer.js";

export {
  DATA_SYNC_SOFT_LIMITS,
  FaultAssertionError,
  FaultHarness,
  cursorAheadFault,
  cursorExpiredFault,
  cursorInvalidFault,
  disconnectBeforeCheckpointFault,
  exceedsDataSyncSoftLimits,
  multiTableTransactionFault,
  notYetLoadedFault,
  oversizedTransactionFault,
  queryFailedFault,
  queryRemovedFault,
  restartMidCdcFault,
  slowConsumerBacklogExhaustionFault,
  tableReplacementFault,
  type BaselineExpectedState,
  type FaultInjector,
  type PublicationState,
} from "./faults/index.js";

export {
  validate,
  type JsonSchema,
  type SchemaValidationError,
} from "./schema_validate.js";
