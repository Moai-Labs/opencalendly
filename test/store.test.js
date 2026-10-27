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
