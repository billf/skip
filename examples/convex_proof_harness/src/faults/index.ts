export {
  FaultAssertionError,
  FaultHarness,
  disconnectBeforeCheckpointFault,
  multiTableTransactionFault,
  notYetLoadedFault,
  queryFailedFault,
  queryRemovedFault,
  slowConsumerBacklogExhaustionFault,
  type FaultCheckpoint,
  type FaultInjector,
  type FaultTrigger,
  type ObservePublicationState,
} from "./injector.js";

export type { BaselineExpectedState, PublicationState } from "./state.js";

export {
  DATA_SYNC_SOFT_LIMITS,
  cursorAheadFault,
  cursorExpiredFault,
  cursorInvalidFault,
  exceedsDataSyncSoftLimits,
  oversizedTransactionFault,
  restartMidCdcFault,
  tableReplacementFault,
} from "./revision_delta.js";
