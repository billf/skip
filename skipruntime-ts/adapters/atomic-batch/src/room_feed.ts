/**
 * The proof-vehicle room feed (P6) and `groupProbe` (Q14's watched state),
 * built entirely on the split per-table collections `split.ts` produces.
 */

import type {
  EagerCollection,
  Json,
  Mapper,
  Reducer,
  Resource,
  Values,
} from "@skipruntime/core";

export type RoomDoc = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly name: string;
};
export type UserDoc = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly name: string;
};
export type MembershipDoc = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly room: string;
  readonly user: string;
  readonly active: boolean;
};
export type MessageDoc = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly room: string;
  readonly sender: string;
  readonly body: string;
};
export type LikeDoc = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly message: string;
  readonly user: string;
};

export type FeedSender = { readonly _id: string; readonly name: string } | null;

export type RoomFeedRow = {
  readonly _id: string;
  readonly _creationTime: number;
  readonly room: string;
  readonly body: string;
  readonly sender: FeedSender;
  readonly likeCount: number;
};

export type GroupProbeValue = {
  readonly active: boolean;
  readonly likeCount: number;
};

/**
 * The composite key an active-membership lookup is keyed by.
 *
 * Invariant: neither id may itself contain `/` (same unescaped-join
 * caveat as `namespacedKey` in keys.ts).
 */
export function membershipKey(room: string, user: string): string {
  return `${room}/${user}`;
}

/**
 * Re-keys a `split.ts`-produced collection (keyed `<component>/<table>/<id>`)
 * by each row's bare `_id`, for the per-table lookups the feed and
 * `groupProbe` join against.
 */
export class ById<V extends { readonly _id: string }>
  implements Mapper<string, V, string, V>
{
  mapEntry(_key: string, values: Values<V>): Iterable<[string, V]> {
    const value = values.getUnique();
    return [[value._id, value]];
  }
}

/** Keeps only active memberships, keyed by `<room>/<user>` (P6's active-membership filter). */
export class ActiveMembershipsByRoomUser
  implements Mapper<string, MembershipDoc, string, true>
{
  mapEntry(
    _key: string,
    memberships: Values<MembershipDoc>,
  ): Iterable<[string, true]> {
    const membership = memberships.getUnique();
    return membership.active
      ? [[membershipKey(membership.room, membership.user), true]]
      : [];
  }
}

/** Re-keys each like row by the message it likes. */
export class LikesByMessage
  implements Mapper<string, LikeDoc, string, LikeDoc>
{
  mapEntry(_key: string, likes: Values<LikeDoc>): Iterable<[string, LikeDoc]> {
    return [...likes].map((like) => [like.message, like] as [string, LikeDoc]);
  }
}

/** Re-keys each message row by the room it belongs to. */
export class MessagesByRoom
  implements Mapper<string, MessageDoc, string, MessageDoc>
{
  mapEntry(
    _key: string,
    messages: Values<MessageDoc>,
  ): Iterable<[string, MessageDoc]> {
    return [...messages].map(
      (message) => [message.room, message] as [string, MessageDoc],
    );
  }
}

/** Per-message like count, with exact inverse removal (no recomputation needed).
 *
 * Zero-valued keys are intentionally retained rather than nulled: `remove`
 * is only ever called paired with a prior `add` per the Reducer contract,
 * so the count cannot go negative in normal framework operation, and
 * readers treat an absent key and a zero count alike.
 */
export class LikeCount implements Reducer<LikeDoc, number> {
  initial: number | null = 0;

  add(accum: number | null, _value: LikeDoc): number {
    return (accum ?? 0) + 1;
  }

  remove(accum: number, _value: LikeDoc): number | null {
    return accum - 1;
  }
}

// Complementing each codepoint against a ceiling reverses per-position
// order, but on its own it preserves the prefix rule (a shorter complemented
// id is still a prefix of a longer one, so it still sorts first) -- exactly
// the wrong direction for an order-reversing key. The trailing terminator
// fixes that: U+10FFFF sits above every possible complement output (the
// ceiling reserves it), so where the shorter id ends, the terminator compares
// against the longer id's next complement output and sorts after it. The
// shorter id therefore sorts after its longer extension, reversing the
// ascending prefix rule just as the per-position complement reverses
// per-position order.
//
// Guarantee: for `_id`s over BMP codepoints (U+0000-U+FFFF -- every realistic
// id alphabet; Convex ids are fixed-width alphanumerics), ascending
// `complementId` order is exactly descending `_id` lexicographic order,
// including differing-length ids. `_id`s containing non-BMP codepoints or
// U+10FFFF itself are outside this guarantee (the former can exceed the
// terminator's lead unit in UTF-16 order; the latter would complement
// negative). Fixed-width ids never reach the terminator unless equal, so
// their relative order is byte-for-byte what the un-terminated complement
// produced.
const ID_COMPLEMENT_CEILING = 0x10fffe;
const ID_TERMINATOR = "\u{10ffff}";

function complementId(id: string): string {
  return (
    [...id]
      .map((ch) => {
        const codePoint = ch.codePointAt(0) ?? 0;
        if (codePoint > ID_COMPLEMENT_CEILING) {
          throw new Error(
            `complementId: codepoint U+${codePoint.toString(16).toUpperCase()} exceeds the BMP guarantee (ids must stay within U+0000-U+FFFF)`,
          );
        }
        return String.fromCodePoint(ID_COMPLEMENT_CEILING - codePoint);
      })
      .join("") + ID_TERMINATOR
  );
}

/**
 * A key whose ascending order (the order `EagerCollection.take` keeps the
 * first entries in) is the canonical descending `[_creationTime, _id]`
 * order: negating `_creationTime` reverses its comparison, and
 * `complementId` reverses the `_id`'s lexicographic comparison in a
 * prefix-safe way (see above), so tied `_creationTime`s break toward the
 * lexicographically larger `_id` first even when the tied `_id`s differ in
 * length.
 */
export function descendingOrderKey(row: {
  readonly _creationTime: number;
  readonly _id: string;
}): readonly [number, string] {
  return [-row._creationTime, complementId(row._id)];
}

/**
 * Projects one room's messages, filtered to senders with an active
 * membership, into `RoomFeedRow`s keyed by `descendingOrderKey` so that
 * `.take(50)` on the mapped collection keeps the 50 most recent messages,
 * tie-broken by descending `_id` (P6).
 *
 * Maps over a messages-by-room collection (see {@link MessagesByRoom}): the
 * input key is the room, so entries for other rooms short-circuit without
 * scanning their messages.
 */
export class RoomFeedRows
  implements Mapper<string, MessageDoc, readonly [number, string], RoomFeedRow>
{
  constructor(
    private readonly room: string,
    private readonly activeMemberships: EagerCollection<string, true>,
    private readonly usersById: EagerCollection<string, UserDoc>,
    private readonly likeCountByMessage: EagerCollection<string, number>,
  ) {}

  mapEntry(
    roomKey: string,
    messages: Values<MessageDoc>,
  ): Iterable<[readonly [number, string], RoomFeedRow]> {
    if (roomKey !== this.room) return [];
    const rows: [readonly [number, string], RoomFeedRow][] = [];
    for (const message of messages) {
      if (message.room !== this.room) continue;
      if (
        this.activeMemberships.getArray(
          membershipKey(message.room, message.sender),
        ).length === 0
      ) {
        continue;
      }
      rows.push([
        descendingOrderKey(message),
        feedRow(message, this.usersById, this.likeCountByMessage),
      ]);
    }
    return rows;
  }
}

/**
 * Single-value-or-default lookup against a by-id-style collection: the
 * first associated value, or `fallback` when the key has none. Shared by
 * `feedRow` and `GroupProbeRows`, which both read optional
 * `likeCountByMessage` rows the same way.
 */
function getOrDefault<V extends Json>(
  collection: EagerCollection<string, V>,
  key: string,
  fallback: V,
): V {
  const rows = collection.getArray(key);
  return rows.length > 0 ? rows[0]! : fallback;
}

function feedRow(
  message: MessageDoc,
  usersById: EagerCollection<string, UserDoc>,
  likeCountByMessage: EagerCollection<string, number>,
): RoomFeedRow {
  const senderRows = usersById.getArray(message.sender);
  const sender: FeedSender =
    senderRows.length > 0
      ? { _id: senderRows[0]!._id, name: senderRows[0]!.name }
      : null;
  const likeCount = getOrDefault(likeCountByMessage, message._id, 0);
  return {
    _id: message._id,
    _creationTime: message._creationTime,
    room: message.room,
    body: message.body,
    sender,
    likeCount,
  };
}

/**
 * `groupProbe` (Q14): `{active, likeCount}` for every message, taken
 * *before* the active-membership filter, so a membership-first tear is
 * observable even though the canonical feed alone would already show the
 * post-transaction row. Derives from the same split collections in the
 * same update as the feed; never enters the Q3 comparison.
 */
export class GroupProbeRows
  implements Mapper<string, MessageDoc, string, GroupProbeValue>
{
  constructor(
    private readonly activeMemberships: EagerCollection<string, true>,
    private readonly likeCountByMessage: EagerCollection<string, number>,
  ) {}

  mapEntry(
    _key: string,
    messages: Values<MessageDoc>,
  ): Iterable<[string, GroupProbeValue]> {
    const message = messages.getUnique();
    const active =
      this.activeMemberships.getArray(
        membershipKey(message.room, message.sender),
      ).length > 0;
    const likeCount = getOrDefault(this.likeCountByMessage, message._id, 0);
    return [[message._id, { active, likeCount }]];
  }
}

/** Shared graph inputs the room feed and `groupProbe` are both built from. */
export type RoomFeedInputs = {
  readonly messagesById: EagerCollection<string, MessageDoc>;
  readonly messagesByRoom: EagerCollection<string, MessageDoc>;
  readonly usersById: EagerCollection<string, UserDoc>;
  readonly activeMemberships: EagerCollection<string, true>;
  readonly likeCountByMessage: EagerCollection<string, number>;
};

/**
 * Builds `messagesByRoom`, `likeCountByMessage`, and `activeMemberships`
 * from the split per-table `messages`, `likes`, and `memberships`
 * collections. Exported so a consumer that already re-keys its own tables
 * can skip straight to {@link buildRoomFeed} / {@link buildGroupProbe} with
 * its own inputs.
 */
export function deriveRoomFeedInputs(collections: {
  readonly messagesById: EagerCollection<string, MessageDoc>;
  readonly usersById: EagerCollection<string, UserDoc>;
  readonly membershipsById: EagerCollection<string, MembershipDoc>;
  readonly likesById: EagerCollection<string, LikeDoc>;
}): RoomFeedInputs {
  return {
    messagesById: collections.messagesById,
    messagesByRoom: collections.messagesById.map(MessagesByRoom),
    usersById: collections.usersById,
    activeMemberships: collections.membershipsById.map(
      ActiveMembershipsByRoomUser,
    ),
    likeCountByMessage: collections.likesById
      .map(LikesByMessage)
      .reduce(LikeCount),
  };
}

/**
 * Builds the canonical room feed as a standalone graph function: the 50
 * most recent messages in `room` whose sender has an active membership,
 * descending `[_creationTime, _id]`.
 */
export function buildRoomFeed(
  room: string,
  inputs: RoomFeedInputs,
): EagerCollection<readonly [number, string], RoomFeedRow> {
  return inputs.messagesByRoom
    .map(
      RoomFeedRows,
      room,
      inputs.activeMemberships,
      inputs.usersById,
      inputs.likeCountByMessage,
    )
    .take(50);
}

/**
 * Builds `groupProbe` as a standalone graph function over the same inputs,
 * so any consumer graph (1a, 1b, 1c) can mount and serve it beside its feed.
 */
export function buildGroupProbe(
  inputs: RoomFeedInputs,
): EagerCollection<string, GroupProbeValue> {
  return inputs.messagesById.map(
    GroupProbeRows,
    inputs.activeMemberships,
    inputs.likeCountByMessage,
  );
}

/** A `Resource` wrapper for `buildRoomFeed`, parameterized by room ID. */
export class RoomFeedResource implements Resource<RoomFeedInputs> {
  constructor(private readonly room: string) {}

  instantiate(
    collections: RoomFeedInputs,
  ): EagerCollection<readonly [number, string], RoomFeedRow> {
    return buildRoomFeed(this.room, collections);
  }
}

/** A `Resource` wrapper for `buildGroupProbe`. */
export class GroupProbeResource implements Resource<RoomFeedInputs> {
  instantiate(
    collections: RoomFeedInputs,
  ): EagerCollection<string, GroupProbeValue> {
    return buildGroupProbe(collections);
  }
}
