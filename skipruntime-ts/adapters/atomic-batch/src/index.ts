/**
 * Provisional atomic multi-table write helpers for external Skip sources.
 *
 * This package publishes the `AtomicSourceBatch` contract (see SPEC.md) and
 * will provide `SnapshotBatch` helpers, split/key/order utilities, and the
 * revision-delta extension in later units. It has no Skip runtime or FFI
 * dependency (P8): it is a convention plus a small library built entirely
 * on `@skipruntime/core`'s public `ExternalService`/`CollectionWriter`
 * surface.
 *
 * @packageDocumentation
 */

import type { Entry, Json } from "@skipruntime/core";

/** Package version, kept in step with `package.json` (asserted by version.test.ts). */
export const ATOMIC_BATCH_VERSION = "0.0.23";

/** Re-exported for consumers building batch entries against this package. */
export type { Entry, Json };

export {
  assertNoDuplicateKeys,
  compareOrderKeyDesc,
  namespacedKey,
  type OrderKey,
} from "./keys.js";
export {
  applySnapshotBatch,
  buildSnapshotEntries,
  type SnapshotEntry,
  type Writer,
} from "./snapshot.js";
export {
  CONTROL_COMPONENT,
  MARKER_TABLE,
  SplitByTable,
  type RevisionEnvelope,
  type TaggedRow,
} from "./split.js";
export {
  ActiveMembershipsByRoomUser,
  ById,
  GroupProbeResource,
  GroupProbeRows,
  LikeCount,
  LikesByMessage,
  RoomFeedResource,
  RoomFeedRows,
  buildGroupProbe,
  buildRoomFeed,
  deriveRoomFeedInputs,
  descendingOrderKey,
  membershipKey,
  type FeedSender,
  type GroupProbeValue,
  type LikeDoc,
  type MembershipDoc,
  type MessageDoc,
  type RoomDoc,
  type RoomFeedInputs,
  type RoomFeedRow,
  type UserDoc,
} from "./room_feed.js";
export {
  GenerationManager,
  PendingPageLedger,
  StagingBuild,
  type GenerationId,
} from "./generation.js";
export {
  RevisionDeltaApplier,
  RevisionDeltaSource,
  compareTs,
  revisionKey,
  type ApplyGroupResult,
  type ApplyResult,
  type PreparedRevisions,
  type Publish,
  type RevisionDeltaEntry,
  type TableRef,
} from "./revision_delta.js";
