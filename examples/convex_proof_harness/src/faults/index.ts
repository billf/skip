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
	type ObservePublicationState,
} from "./injector.js";

export type { BaselineExpectedState, PublicationState } from "./state.js";
