import assert from "node:assert/strict";
import { test } from "node:test";
import { deepFreeze } from "@skipruntime/core";
import type {
  Context,
  DepSafe,
  EagerCollection,
  Json,
  Mapper,
  Reducer,
  Values,
} from "@skipruntime/core";
import {
  ActiveMembershipsByRoomUser,
  ById,
  GroupProbeRows,
  LikeCount,
  LikesByMessage,
  MessagesByRoom,
  RoomFeedRows,
  buildRoomFeed,
  deriveRoomFeedInputs,
  descendingOrderKey,
  membershipKey,
  type LikeDoc,
  type MembershipDoc,
  type MessageDoc,
  type UserDoc,
} from "./room_feed.js";

// A fake EagerCollection sufficient for the lookups (`getArray`) these
// mappers perform when invoked directly, outside a live Skip graph. Only
// `getArray` is exercised: these are pure-logic unit tests of the mapper
// classes' `mapEntry` methods, not a runtime-backed reactive graph.
function fakeCollection<K extends Json, V extends Json>(
  entries: readonly (readonly [K, readonly V[]])[],
): EagerCollection<K, V> {
  const byKey = new Map<K, V[]>(entries.map(([k, vs]) => [k, [...vs]]));
  return {
    getArray: (key: K) => (byKey.get(key) ?? []).map((v) => deepFreeze(v)),
  } as unknown as EagerCollection<K, V>;
}

function values<T>(value: T) {
  const frozen = deepFreeze(value);
  return {
    getUnique: () => frozen,
    toArray: () => [frozen],
    [Symbol.iterator]: () => [frozen][Symbol.iterator](),
  };
}

const room = "room-1";
const alice: UserDoc = { _id: "u-alice", _creationTime: 1, name: "Alice" };

function message(over: Partial<MessageDoc> = {}): MessageDoc {
  return {
    _id: "m1",
    _creationTime: 100,
    room,
    sender: alice._id,
    body: "hi",
    ...over,
  };
}

test("ActiveMembershipsByRoomUser keeps only active memberships, keyed by room/user", () => {
  const mapper = new ActiveMembershipsByRoomUser();
  const active: MembershipDoc = {
    _id: "ms1",
    _creationTime: 1,
    room,
    user: alice._id,
    active: true,
  };
  const inactive: MembershipDoc = {
    _id: "ms2",
    _creationTime: 1,
    room,
    user: "u-bob",
    active: false,
  };
  assert.deepEqual(
    [...mapper.mapEntry("ms1", values(active))],
    [[membershipKey(room, alice._id), true]],
  );
  assert.deepEqual([...mapper.mapEntry("ms2", values(inactive))], []);
});

test("LikesByMessage re-keys a like row by the message it likes", () => {
  const mapper = new LikesByMessage();
  const like: LikeDoc = {
    _id: "l1",
    _creationTime: 1,
    message: "m1",
    user: "u-bob",
  };
  assert.deepEqual([...mapper.mapEntry("l1", values(like))], [["m1", like]]);
});

test("MessagesByRoom re-keys a message row by its room", () => {
  const mapper = new MessagesByRoom();
  assert.deepEqual(
    [...mapper.mapEntry("m1", values(message()))],
    [[room, message()]],
  );
});

test("LikeCount: adding then removing a like returns the count to 0", () => {
  const reducer = new LikeCount();
  const like: LikeDoc = {
    _id: "l1",
    _creationTime: 1,
    message: "m1",
    user: "u-bob",
  };
  const afterAdd = reducer.add(reducer.initial, like);
  assert.equal(afterAdd, 1);
  const afterRemove = reducer.remove(afterAdd, like);
  assert.equal(afterRemove, 0);
});

test("a deleted sender yields sender: null in the feed row", () => {
  // RoomFeedRows maps over a messages-by-room collection (see MessagesByRoom),
  // so the input key under test is the room, not the message id.
  const activeMemberships = fakeCollection<string, true>([
    [membershipKey(room, alice._id), [true]],
  ]);
  const usersById = fakeCollection<string, UserDoc>([]); // sender's user row is gone
  const likeCountByMessage = fakeCollection<string, number>([]);
  const mapper = new RoomFeedRows(
    room,
    activeMemberships,
    usersById,
    likeCountByMessage,
  );
  const rows = [...mapper.mapEntry(room, values(message()))];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![1].sender, null);
});

test("flipping membership includes or excludes the message from the feed", () => {
  const usersById = fakeCollection([[alice._id, [alice]]]);
  const likeCountByMessage = fakeCollection<string, number>([]);

  const withActive = new RoomFeedRows(
    room,
    fakeCollection<string, true>([[membershipKey(room, alice._id), [true]]]),
    usersById,
    likeCountByMessage,
  );
  assert.equal([...withActive.mapEntry(room, values(message()))].length, 1);

  const withoutActive = new RoomFeedRows(
    room,
    fakeCollection<string, true>([]),
    usersById,
    likeCountByMessage,
  );
  assert.equal([...withoutActive.mapEntry(room, values(message()))].length, 0);
});

test("deleting a liked user keeps the like count (feed row reads likeCountByMessage, not users)", () => {
  const activeMemberships = fakeCollection<string, true>([
    [membershipKey(room, alice._id), [true]],
  ]);
  const usersById = fakeCollection([[alice._id, [alice]]]);
  const likeCountByMessage = fakeCollection([["m1", [3]]]);
  const mapper = new RoomFeedRows(
    room,
    activeMemberships,
    usersById,
    likeCountByMessage,
  );
  const rows = [...mapper.mapEntry(room, values(message()))];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![1].likeCount, 3);
});

test("groupProbe reports {active, likeCount} for a message whose membership is inactive", () => {
  const activeMemberships = fakeCollection<string, true>([]); // no active membership recorded
  const likeCountByMessage = fakeCollection([["m1", [2]]]);
  const mapper = new GroupProbeRows(activeMemberships, likeCountByMessage);
  assert.deepEqual(
    [...mapper.mapEntry("m1", values(message()))],
    [["m1", { active: false, likeCount: 2 }]],
  );
});

test("groupProbe and the feed derive active/likeCount from the same inputs", () => {
  const activeMemberships = fakeCollection<string, true>([
    [membershipKey(room, alice._id), [true]],
  ]);
  const likeCountByMessage = fakeCollection([["m1", [1]]]);
  const probe = new GroupProbeRows(activeMemberships, likeCountByMessage);
  assert.deepEqual(
    [...probe.mapEntry("m1", values(message()))],
    [["m1", { active: true, likeCount: 1 }]],
  );
});

// Order-key semantics: `.take(50)`, per the Skip API, keeps the first
// entries in ascending Json-array order. `descendingOrderKey` is designed
// so ascending order over its output is exactly descending
// `[_creationTime, _id]` order; this test proves that property directly,
// independent of any live Skip graph (which this checkout cannot run —
// see room_feed's toolchain note below).
function compareJsonArrayKey(
  a: readonly [number, string],
  b: readonly [number, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

test("51 messages: taking the first 50 by ascending descendingOrderKey keeps the 50 most recent, tied _id descending", () => {
  const messages: MessageDoc[] = [];
  for (let i = 0; i < 49; i++) {
    messages.push(
      message({ _id: `m${String(i).padStart(3, "0")}`, _creationTime: i }),
    );
  }
  // A tied pair at the highest creation time, differing only by _id.
  messages.push(message({ _id: "m100", _creationTime: 100 }));
  messages.push(message({ _id: "m101", _creationTime: 100 }));

  assert.equal(messages.length, 51);

  const ordered = [...messages]
    .map((m) => ({ m, key: descendingOrderKey(m) }))
    .sort((a, b) => compareJsonArrayKey(a.key, b.key))
    .slice(0, 50)
    .map((x) => x.m);

  assert.equal(ordered.length, 50);
  // The tied pair (creationTime 100) must appear with m101 (higher _id) first.
  assert.equal(ordered[0]!._id, "m101");
  assert.equal(ordered[1]!._id, "m100");
  // The oldest message (creationTime 0) is the one dropped.
  assert.ok(!ordered.some((m) => m._id === "m000"));
});

test("descendingOrderKey reverses differing-length _ids: a longer extension sorts first", () => {
  const short = message({ _id: "a", _creationTime: 50 });
  const long = message({ _id: "ab", _creationTime: 50 });
  const ordered = [short, long]
    .map((m) => ({ m, key: descendingOrderKey(m) }))
    .sort((x, y) => compareJsonArrayKey(x.key, y.key))
    .map((x) => x.m._id);
  // Descending `_id` order wants "ab" (the larger id) before its prefix "a".
  assert.deepEqual(ordered, ["ab", "a"]);
});

test("descendingOrderKey lets differing content dominate length", () => {
  const aa = message({ _id: "aa", _creationTime: 50 });
  const b = message({ _id: "b", _creationTime: 50 });
  const ordered = [aa, b]
    .map((m) => ({ m, key: descendingOrderKey(m) }))
    .sort((x, y) => compareJsonArrayKey(x.key, y.key))
    .map((x) => x.m._id);
  // Ascending "aa" < "b", so descending wants "b" first despite being shorter.
  assert.deepEqual(ordered, ["b", "aa"]);
});

test("descendingOrderKey throws a descriptive error for an _id outside the BMP guarantee, instead of a raw RangeError", () => {
  const outsideBmp = message({ _id: "\u{10ffff}", _creationTime: 50 });
  assert.throws(
    () => descendingOrderKey(outsideBmp),
    /U\+10FFFF exceeds the BMP guarantee/,
  );
});

// A minimal in-memory `EagerCollection` stand-in with `map`/`reduce`/`take`
// mirroring the real signatures (mapper/reducer classes instantiated
// internally), so the split -> ById -> deriveRoomFeedInputs wiring below
// typechecks and runs end-to-end without a live Skip graph (cf. the
// `mappableSource` stub in split.test.ts). Keys are indexed by their JSON
// encoding so array keys (e.g. order-key tuples) look up by value.
function miniValues<T>(items: readonly T[]): Values<T> {
  const frozen = items.map((item) => deepFreeze(item));
  return {
    getUnique: () => {
      if (frozen.length !== 1) {
        throw new Error(`expected exactly one value, got ${frozen.length}`);
      }
      return frozen[0]!;
    },
    toArray: () => [...frozen],
    [Symbol.iterator]: () => frozen[Symbol.iterator](),
  };
}

const noContext = {} as Context;

function compareJson(a: Json, b: Json): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const cmp = compareJson(a[i] as Json, b[i] as Json);
      if (cmp !== 0) return cmp;
    }
    return a.length - b.length;
  }
  // Mixed-type or other Json (boolean/null/object): order by JSON encoding.
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function miniEager<K extends Json, V extends Json>(
  entries: readonly (readonly [K, readonly V[]])[],
): EagerCollection<K, V> {
  const byKey = new Map<string, { key: K; values: V[] }>();
  for (const [key, values] of entries) {
    byKey.set(JSON.stringify(key), { key, values: [...values] });
  }
  const self = {
    getArray: (key: K) =>
      [...(byKey.get(JSON.stringify(key))?.values ?? [])].map((v) =>
        deepFreeze(v),
      ),
    map<K2 extends Json, V2 extends Json, Params extends readonly DepSafe[]>(
      MapperClass: new (...params: Params) => Mapper<K, V, K2, V2>,
      ...params: Params
    ): EagerCollection<K2, V2> {
      const mapper = new MapperClass(...params);
      const grouped = new Map<string, { key: K2; values: V2[] }>();
      for (const { key, values } of byKey.values()) {
        for (const [k2, v2] of mapper.mapEntry(
          key,
          miniValues(values),
          noContext,
        )) {
          const slot = grouped.get(JSON.stringify(k2));
          if (slot) slot.values.push(v2);
          else grouped.set(JSON.stringify(k2), { key: k2, values: [v2] });
        }
      }
      return miniEager(
        [...grouped.values()].map(({ key, values }) => [key, values] as const),
      );
    },
    reduce<Accum extends Json, Params extends readonly DepSafe[]>(
      ReducerClass: new (...params: Params) => Reducer<V, Accum>,
      ...params: Params
    ): EagerCollection<K, Accum> {
      const reducer = new ReducerClass(...params);
      const out: (readonly [K, readonly Accum[]])[] = [];
      for (const { key, values } of byKey.values()) {
        let accum: Accum | null = reducer.initial;
        for (const value of values) {
          accum = reducer.add(accum, value as V & DepSafe);
        }
        if (accum !== null) out.push([key, [accum]]);
      }
      return miniEager(out);
    },
    take(limit: number): EagerCollection<K, V> {
      const sorted = [...byKey.values()]
        .sort((a, b) => compareJson(a.key, b.key))
        .slice(0, limit);
      return miniEager(sorted.map(({ key, values }) => [key, values] as const));
    },
  };
  return self as unknown as EagerCollection<K, V>;
}

test("ById wires split.ts-shaped output into deriveRoomFeedInputs and the feed", () => {
  const otherRoom = "room-2";
  const bob: UserDoc = { _id: "u-bob", _creationTime: 2, name: "Bob" };
  const activeMembership: MembershipDoc = {
    _id: "ms1",
    _creationTime: 3,
    room,
    user: alice._id,
    active: true,
  };
  const like: LikeDoc = {
    _id: "l1",
    _creationTime: 4,
    message: "m1",
    user: bob._id,
  };

  // Per-table collections as `split.ts` produces them: keyed
  // `<component>/<table>/<id>`, one row per key, spanning two rooms.
  const splitMessages = miniEager<string, MessageDoc>([
    ["room-feed/messages/m1", [message()]],
    [
      "room-feed/messages/m2",
      [message({ _id: "m2", room: otherRoom, sender: bob._id })],
    ],
  ]);
  const splitUsers = miniEager<string, UserDoc>([
    ["room-feed/users/u-alice", [alice]],
    ["room-feed/users/u-bob", [bob]],
  ]);
  const splitMemberships = miniEager<string, MembershipDoc>([
    ["room-feed/memberships/ms1", [activeMembership]],
  ]);
  const splitLikes = miniEager<string, LikeDoc>([
    ["room-feed/likes/l1", [like]],
  ]);

  // ById re-keys each split output by the row's bare `_id`.
  const messagesById = splitMessages.map<string, MessageDoc, []>(ById);
  const usersById = splitUsers.map<string, UserDoc, []>(ById);
  const membershipsById = splitMemberships.map<string, MembershipDoc, []>(ById);
  const likesById = splitLikes.map<string, LikeDoc, []>(ById);
  assert.deepEqual(messagesById.getArray("m1"), [message()]);
  assert.deepEqual(usersById.getArray(alice._id), [alice]);

  const inputs = deriveRoomFeedInputs({
    messagesById,
    usersById,
    membershipsById,
    likesById,
  });

  // The derived graph inputs resolve through the wired collections.
  assert.deepEqual(
    inputs.activeMemberships.getArray(membershipKey(room, alice._id)),
    [true],
  );
  assert.deepEqual(inputs.likeCountByMessage.getArray("m1"), [1]);
  assert.deepEqual(inputs.likeCountByMessage.getArray("m2"), []);
  assert.deepEqual(
    inputs.messagesByRoom.getArray(room).map((m) => m._id),
    ["m1"],
  );
  assert.deepEqual(
    inputs.messagesByRoom.getArray(otherRoom).map((m) => m._id),
    ["m2"],
  );

  // The room feed over the wired inputs contains only room-1's message, with
  // the sender join and like count resolved; the other room's message is
  // filtered by the room-keyed scan.
  const feed = buildRoomFeed(room, inputs);
  const rows = feed.getArray(descendingOrderKey(message()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.body, "hi");
  assert.deepEqual(rows[0]!.sender, { _id: alice._id, name: alice.name });
  assert.equal(rows[0]!.likeCount, 1);
  const otherKey = descendingOrderKey(
    message({ _id: "m2", room: otherRoom, sender: bob._id }),
  );
  assert.deepEqual(feed.getArray(otherKey), []);
});
