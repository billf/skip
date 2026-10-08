import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenerationManager,
  PendingPageLedger,
  StagingBuild,
} from "./generation.js";

test("PendingPageLedger completes only once every named group is marked applied", () => {
  const ledger = new PendingPageLedger(["g1", "g2"]);
  assert.equal(ledger.isComplete, false);
  ledger.markGroupApplied("g1");
  assert.equal(ledger.isComplete, false);
  ledger.markGroupApplied("g2");
  assert.equal(ledger.isComplete, true);
  assert.deepEqual(ledger.remainingGroups, []);
});

test("marking an unnamed group throws, but re-marking an applied group is a no-op", () => {
  const ledger = new PendingPageLedger(["g1"]);
  assert.throws(() => ledger.markGroupApplied("g2"));
  ledger.markGroupApplied("g1");
  assert.equal(ledger.isComplete, true);
  ledger.markGroupApplied("g1"); // idempotent retry: no-op, no throw
  assert.equal(ledger.isComplete, true);
});

test("PendingPageLedger rejects duplicate group ids and an empty group list", () => {
  assert.throws(
    () => new PendingPageLedger(["g1", "g1"]),
    "duplicate group ids must throw",
  );
  assert.throws(() => new PendingPageLedger([]), "empty group list must throw");
});

test("a cold multi-page staging build publishes nothing partial and promotes once", () => {
  const build = new StagingBuild<string, string>();
  const page1 = build.beginPage(["g1"]);
  const page2 = build.beginPage(["g2"]);
  build.write("k1", ["v1"]);
  page1.markGroupApplied("g1");
  assert.equal(build.isReadyToPromote, false, "page 2 still pending");
  assert.throws(() => build.promote());

  build.write("k2", ["v2"]);
  page2.markGroupApplied("g2");
  assert.equal(build.isReadyToPromote, true);
  const promoted = build.promote();
  assert.deepEqual([...promoted.entries()].sort(), [
    ["k1", ["v1"]],
    ["k2", ["v2"]],
  ]);
  assert.throws(() => build.promote(), "cannot promote twice");
  assert.throws(
    () => build.write("k3", ["v3"]),
    "cannot write after promotion",
  );
});

test("GenerationManager: a second replacement restarts only the candidate", () => {
  const manager = new GenerationManager<string, string>();
  const gen1 = manager.beginGeneration();
  const staging1 = manager.stagingFor(gen1)!;
  staging1.beginPage(["g1"]).markGroupApplied("g1");
  staging1.write("k1", ["gen1-value"]);

  // A second replacement begins before gen1 promotes.
  const gen2 = manager.beginGeneration();
  assert.notEqual(gen1, gen2);
  assert.equal(manager.isCurrentGeneration(gen1), false);
  assert.equal(manager.isCurrentGeneration(gen2), true);

  // gen1 is now stale: any further access is a late event, dropped.
  assert.equal(manager.stagingFor(gen1), undefined);
  assert.equal(manager.promote(gen1), false);

  const staging2 = manager.stagingFor(gen2)!;
  staging2.beginPage(["g1"]).markGroupApplied("g1");
  staging2.write("k1", ["gen2-value"]);
  assert.equal(manager.promote(gen2), true);
  assert.deepEqual(manager.currentSnapshot.get("k1"), ["gen2-value"]);
});

test("a late event from an old generation is dropped and counted", () => {
  const manager = new GenerationManager<string, string>();
  const gen1 = manager.beginGeneration();
  manager.beginGeneration(); // supersedes gen1
  assert.equal(manager.lateEventDropCount, 0);
  assert.equal(manager.stagingFor(gen1), undefined);
  assert.equal(manager.lateEventDropCount, 1);
  assert.equal(manager.promote(gen1), false);
  assert.equal(manager.lateEventDropCount, 2);
});

test("re-promoting the already-promoted current generation is idempotent", () => {
  const manager = new GenerationManager<string, string>();
  const gen = manager.beginGeneration();
  const staging = manager.stagingFor(gen)!;
  staging.beginPage(["g1"]).markGroupApplied("g1");
  staging.write("k1", ["v1"]);
  assert.equal(manager.promote(gen), true);
  assert.equal(
    manager.promote(gen),
    true,
    "second promote of the current generation must not throw",
  );
  assert.deepEqual(manager.currentSnapshot.get("k1"), ["v1"]);
});

test("promoted snapshot arrays are frozen: mutation throws and content stays intact", () => {
  const manager = new GenerationManager<string, string>();
  const gen = manager.beginGeneration();
  const staging = manager.stagingFor(gen)!;
  staging.beginPage(["g1"]).markGroupApplied("g1");
  staging.write("k1", ["v1"]);
  assert.equal(manager.promote(gen), true);
  const values = manager.currentSnapshot.get("k1")!;
  assert.equal(Object.isFrozen(values), true);
  assert.throws(() => {
    (values as string[]).push("mutant");
  });
  assert.deepEqual(manager.currentSnapshot.get("k1"), ["v1"]);
});
