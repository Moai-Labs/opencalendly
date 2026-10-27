"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../lib/store");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-store-"));
}

test("a store persists its mutations to disk", async () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const result = await store.createOrganizer({
    name: "Ada", email: "ada@example.com", passwordHash: "h", salt: "s",
    slug: "ada123", timezone: "UTC",
    event: { name: "30 minute meeting", durationMinutes: 30, availability: {} },
  });
  assert.ok(result.ok);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.strictEqual(onDisk.organizers.length, 1);
  assert.strictEqual(onDisk.organizers[0].slug, "ada123");
  // No temp file left behind: writes are atomic temp-then-rename.
  assert.ok(!fs.existsSync(path.join(dir, "state.json.tmp")));
});

test("a store restores its state on a fresh boot", async () => {
  const dir = tmpDir();
  const first = new Store(dir).init();
  await first.createOrganizer({
    name: "Ada", email: "ada@example.com", passwordHash: "h", salt: "s",
    slug: "ada123", timezone: "Europe/Berlin",
    event: { name: "30 minute meeting", durationMinutes: 30, availability: { "1": [{ s: "09:00", e: "17:00" }] } },
  });
  const booking = await first.createBooking({
    organizerId: first.state.organizers[0].id,
    startMs: Date.UTC(2026, 10, 3, 9, 0),
    endMs: Date.UTC(2026, 10, 3, 9, 30),
    guestName: "Guest", guestEmail: "guest@example.com",
  });
  assert.ok(booking.ok);

  const second = new Store(dir).init();
  assert.strictEqual(second.state.organizers.length, 1);
  assert.strictEqual(second.state.organizers[0].timezone, "Europe/Berlin");
  assert.strictEqual(second.state.bookings.length, 1);
  assert.strictEqual(second.findBooking(booking.booking.id).guestName, "Guest");
  // The session secret survives, so organizer logins survive a restart too.
  assert.strictEqual(second.state.meta.sessionSecret, first.state.meta.sessionSecret);
});

test("double-booking is rejected, including a concurrent race", async () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const org = (await store.createOrganizer({
    name: "Ada", email: "ada@example.com", passwordHash: "h", salt: "s",
    slug: "ada123", timezone: "UTC",
    event: { name: "30 minute meeting", durationMinutes: 30, availability: {} },
  })).organizer;

  const start = Date.UTC(2026, 10, 3, 9, 0);
  const end = Date.UTC(2026, 10, 3, 9, 30);
  const first = await store.createBooking({ organizerId: org.id, startMs: start, endMs: end, guestName: "A", guestEmail: "a@example.com" });
  assert.ok(first.ok);

  const overlapping = await store.createBooking({ organizerId: org.id, startMs: Date.UTC(2026, 10, 3, 9, 15), endMs: Date.UTC(2026, 10, 3, 9, 45), guestName: "B", guestEmail: "b@example.com" });
  assert.strictEqual(overlapping.ok, false);
  assert.strictEqual(overlapping.code, "conflict");

  // Ten simultaneous attempts on one free slot: exactly one wins.
  const slotStart = Date.UTC(2026, 10, 3, 10, 0);
  const attempts = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      store.createBooking({ organizerId: org.id, startMs: slotStart, endMs: slotStart + 30 * 60000, guestName: `G${i}`, guestEmail: `g${i}@example.com` })
    )
  );
  assert.strictEqual(attempts.filter((r) => r.ok).length, 1);
  assert.strictEqual(attempts.filter((r) => !r.ok && r.code === "conflict").length, 9);
  assert.strictEqual(store.state.bookings.length, 2);
});

test("bookings of different organizers never conflict", async () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const mk = async (slug, email) =>
    (await store.createOrganizer({
      name: slug, email, passwordHash: "h", salt: "s", slug, timezone: "UTC",
      event: { name: "x", durationMinutes: 30, availability: {} },
    })).organizer;
  const a = await mk("aaa111", "a@example.com");
  const b = await mk("bbb222", "b@example.com");
  const start = Date.UTC(2026, 10, 3, 9, 0);
  assert.ok((await store.createBooking({ organizerId: a.id, startMs: start, endMs: start + 1800000, guestName: "G", guestEmail: "g@example.com" })).ok);
  assert.ok((await store.createBooking({ organizerId: b.id, startMs: start, endMs: start + 1800000, guestName: "G", guestEmail: "g@example.com" })).ok);
});

test("a corrupt state file is moved aside, not silently overwritten", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "state.json"), "{not json at all");
  const store = new Store(dir).init();
  assert.strictEqual(store.state.organizers.length, 0);
  const backup = fs.readdirSync(dir).find((f) => f.startsWith("state.json.corrupt-"));
  assert.ok(backup, "corrupt file kept for recovery");
  assert.strictEqual(fs.readFileSync(path.join(dir, backup), "utf8"), "{not json at all");
});

test("organizer signup rejects duplicate emails", async () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  const args = { name: "Ada", email: "ada@example.com", passwordHash: "h", salt: "s", slug: "aaa111", timezone: "UTC", event: { name: "x", durationMinutes: 30, availability: {} } };
  assert.ok((await store.createOrganizer(args)).ok);
  const dup = await store.createOrganizer({ ...args, slug: "bbb222" });
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.code, "email_taken");
});

test("the outbox persists and caps its size", async () => {
  const dir = tmpDir();
  const store = new Store(dir).init();
  for (let i = 0; i < 520; i++) await store.appendOutbox({ id: `e${i}`, to: "g@example.com", subject: "s", text: "t" });
  assert.strictEqual(store.state.outbox.length, 500);
  assert.strictEqual(store.state.outbox[0].id, "e20"); // oldest dropped
  const restored = new Store(dir).init();
  assert.strictEqual(restored.state.outbox.length, 500);
});

// --- Step 2: cancellation, rescheduling, export, deletion --------------------

async function organizerWithSlots(store) {
  const result = await store.createOrganizer({
    name: "Ada", email: `ada-${Math.random().toString(36).slice(2)}@example.com`, passwordHash: "h", salt: "s",
    slug: `ada${Math.random().toString(36).slice(2, 8)}`, timezone: "UTC",
    event: {
      name: "30 minute meeting", durationMinutes: 30,
      // Weekdays 09:00-17:00 UTC, so the fixed Monday slots below always land.
      availability: { "1": [{ s: "09:00", e: "17:00" }], "2": [{ s: "09:00", e: "17:00" }], "3": [{ s: "09:00", e: "17:00" }], "4": [{ s: "09:00", e: "17:00" }], "5": [{ s: "09:00", e: "17:00" }] },
    },
  });
  return result.organizer;
}

const MON = Date.UTC(2026, 10, 2, 9, 0); // a Monday 09:00 UTC
const slot = (n) => ({ startMs: MON + n * 30 * 60000, endMs: MON + (n + 1) * 30 * 60000 });

test("a cancelled booking frees its slot for other guests", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  const first = await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "A", guestEmail: "a@example.com" });
  assert.ok(first.ok);

  // While held, the overlapping slot is refused.
  const during = await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "B", guestEmail: "b@example.com" });
  assert.strictEqual(during.ok, false);

  const cancelled = await store.cancelBooking(first.booking.id, { by: "guest", reason: "cannot make it" });
  assert.ok(cancelled.ok);
  assert.strictEqual(cancelled.booking.status, "cancelled");
  assert.strictEqual(cancelled.booking.cancellationReason, "cannot make it");
  assert.ok(cancelled.booking.cancelledAt > 0);

  // The slot is bookable again, by a new guest.
  const again = await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "B", guestEmail: "b@example.com" });
  assert.ok(again.ok, "the freed slot is bookable again");

  // Cancelling twice is idempotent, not an error.
  const twice = await store.cancelBooking(first.booking.id, {});
  assert.ok(twice.ok);
  assert.ok(twice.already);

  assert.strictEqual((await store.cancelBooking("no-such-id", {})).ok, false);
});

test("rescheduling moves a booking and frees its old slot", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  const booking = (await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "A", guestEmail: "a@example.com" })).booking;

  const moved = await store.rescheduleBooking(booking.id, { startMs: slot(4).startMs, endMs: slot(4).endMs, by: "guest" });
  assert.ok(moved.ok);
  assert.strictEqual(moved.booking.id, booking.id, "the booking keeps its id, so links and calendar files stay valid");
  assert.strictEqual(moved.booking.startMs, slot(4).startMs);
  assert.strictEqual(moved.booking.previousStartMs, slot(0).startMs);
  assert.strictEqual(moved.booking.rescheduledBy, "guest");

  // The old slot is free again; the new one is held.
  const oldSlot = await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "B", guestEmail: "b@example.com" });
  assert.ok(oldSlot.ok, "the old slot is bookable again");
  const newSlot = await store.createBooking({ organizerId: org.id, ...slot(4), guestName: "C", guestEmail: "c@example.com" });
  assert.strictEqual(newSlot.ok, false, "the new slot is held");

  // Same slot again is a no-op, not a new history entry.
  const noop = await store.rescheduleBooking(booking.id, { startMs: slot(4).startMs, endMs: slot(4).endMs, by: "guest" });
  assert.ok(noop.ok);
  assert.strictEqual(noop.booking.previousStartMs, slot(0).startMs, "no second history entry");

  // Bad input is refused.
  assert.strictEqual((await store.rescheduleBooking(booking.id, { startMs: "x", endMs: 1 })).code, "bad_slot");
  assert.strictEqual((await store.rescheduleBooking("no-such-id", { startMs: 1, endMs: 2 })).code, "not_found");
});

test("a reschedule cannot land on a slot another guest just took, even concurrently", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  const guest1 = (await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "One", guestEmail: "one@example.com" })).booking;

  // Both orders of the race: a new booking and a reschedule aiming at the
  // same free slot, issued together. The store lock serializes them, so
  // exactly one wins each time. Each round uses its own target slot, since
  // the winner of a round keeps holding it.
  for (const round of [{ order: "book-first", target: slot(10) }, { order: "reschedule-first", target: slot(12) }]) {
    const { order, target } = round;
    const ops = [
      () => store.createBooking({ organizerId: org.id, ...target, guestName: "Two", guestEmail: "two@example.com" }),
      () => store.rescheduleBooking(guest1.id, { startMs: target.startMs, endMs: target.endMs, by: "guest" }),
    ];
    if (order === "reschedule-first") ops.reverse();
    const results = await Promise.all([ops[0](), ops[1]()]);
    assert.strictEqual(results.filter((r) => r.ok).length, 1, `${order}: exactly one wins`);

    // Whatever won, the target slot is held by exactly one active booking.
    const active = store.state.bookings.filter((b) => b.status !== "cancelled" && b.startMs < target.endMs && target.startMs < b.endMs);
    assert.strictEqual(active.length, 1);

    // If guest 1 won the race they are off their home slot; move them back
    // for the next round. Otherwise they stayed home and the target's
    // winner keeps it.
    if (store.findBooking(guest1.id).startMs !== slot(0).startMs) {
      const back = await store.rescheduleBooking(guest1.id, { startMs: slot(0).startMs, endMs: slot(0).endMs, by: "guest" });
      assert.ok(back.ok, "guest 1 can move back for the next round");
    }
    assert.strictEqual(store.findBooking(guest1.id).startMs, slot(0).startMs);
  }

  // Sequential version: once another guest holds the slot, the reschedule is refused.
  const lateTarget = slot(14);
  assert.ok((await store.createBooking({ organizerId: org.id, ...lateTarget, guestName: "Three", guestEmail: "three@example.com" })).ok);
  const conflict = await store.rescheduleBooking(guest1.id, { startMs: lateTarget.startMs, endMs: lateTarget.endMs, by: "guest" });
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.code, "conflict");
  assert.strictEqual(store.findBooking(guest1.id).startMs, slot(0).startMs, "the booking did not move");
});

test("a cancelled booking cannot be rescheduled", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  const booking = (await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "A", guestEmail: "a@example.com" })).booking;
  await store.cancelBooking(booking.id, {});
  const moved = await store.rescheduleBooking(booking.id, { startMs: slot(4).startMs, endMs: slot(4).endMs, by: "guest" });
  assert.strictEqual(moved.ok, false);
  assert.strictEqual(moved.code, "cancelled");
});

test("the export holds the organizer's data but not password material", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "A", guestEmail: "a@example.com" });
  await store.appendOutbox({ id: "e1", organizerId: org.id, to: "a@example.com", subject: "Confirmed", text: "hello" });
  await store.appendOutbox({ id: "e2", organizerId: "someone-else", to: "x@example.com", subject: "Other", text: "no" });

  const data = store.exportOrganizerData(org.id);
  assert.ok(data.exportedAt);
  assert.strictEqual(data.organizer.id, org.id);
  assert.strictEqual(data.organizer.slug, org.slug);
  assert.strictEqual(data.organizer.passwordHash, undefined, "no password hash in the export");
  assert.strictEqual(data.organizer.salt, undefined, "no salt in the export");
  assert.strictEqual(data.bookings.length, 1);
  assert.strictEqual(data.bookings[0].guestEmail, "a@example.com");
  assert.strictEqual(data.outbox.length, 1, "only this organizer's emails are in the export");
  // Copies, not live references: mutating the export cannot touch the store.
  data.bookings[0].guestEmail = "tampered";
  assert.strictEqual(store.findBooking(data.bookings[0].id).guestEmail, "a@example.com");

  assert.strictEqual(store.exportOrganizerData("no-such-id"), null);
});

test("deleting an organizer removes their data and anonymizes their bookings", async () => {
  const store = new Store(tmpDir()).init();
  const org = await organizerWithSlots(store);
  const booking = (await store.createBooking({ organizerId: org.id, ...slot(0), guestName: "A", guestEmail: "a@example.com" })).booking;
  await store.appendOutbox({ id: "e1", organizerId: org.id, to: "a@example.com", subject: "Confirmed", text: "hello" });

  const deleted = await store.deleteOrganizer(org.id);
  assert.ok(deleted.ok);

  assert.strictEqual(store.state.organizers.length, 0, "the organizer is gone");
  assert.strictEqual(store.state.outbox.length, 0, "the email record is gone");
  assert.strictEqual(store.exportOrganizerData(org.id), null);

  // The booking stays as an anonymous stub so the guest's links answer
  // clearly, but carries none of the guest's data.
  const stub = store.findBooking(booking.id);
  assert.ok(stub, "the booking record answers");
  assert.strictEqual(stub.status, "cancelled");
  assert.strictEqual(stub.guestName, "");
  assert.strictEqual(stub.guestEmail, "");
  assert.strictEqual(stub.guestNote, "");
  assert.strictEqual(stub.cancelledBy, "organizer_deleted");

  // And the slot is free: nothing blocks a new booking.
  const other = await organizerWithSlots(store);
  const fresh = await store.createBooking({ organizerId: other.id, ...slot(0), guestName: "New", guestEmail: "new@example.com" });
  assert.ok(fresh.ok);

  assert.strictEqual((await store.deleteOrganizer("no-such-id")).code, "not_found");
});
