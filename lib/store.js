// Persistent storage: one JSON file in the data directory, written atomically
// (temp file + rename) on every mutation. All mutations serialize through a
// single promise chain, so a booking's conflict check and write happen together
// under the lock — that is the double-booking protection.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function freshState() {
  return {
    meta: { version: 1, sessionSecret: crypto.randomBytes(32).toString("hex") },
    organizers: [],
    bookings: [],
    outbox: [],
  };
}

function normalize(parsed) {
  const fresh = freshState();
  return {
    meta: {
      version: 1,
      sessionSecret: typeof parsed.meta?.sessionSecret === "string" ? parsed.meta.sessionSecret : fresh.meta.sessionSecret,
    },
    organizers: Array.isArray(parsed.organizers) ? parsed.organizers : [],
    bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
    outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
  };
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "state.json");
    this.tmpFile = path.join(dataDir, "state.json.tmp");
    this.state = null;
    this.chain = Promise.resolve();
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      raw = null; // first boot on this data directory
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.organizers)) {
          throw new Error("unexpected shape");
        }
        this.state = normalize(parsed);
      } catch (err) {
        // Never overwrite unreadable state silently: move it aside so it can be
        // recovered by hand, then start fresh.
        const backup = this.file + ".corrupt-" + Date.now();
        fs.renameSync(this.file, backup);
        console.error(`store: state file unreadable (${err.message}); moved to ${backup} and starting fresh`);
        this.state = freshState();
      }
    } else {
      this.state = freshState();
    }
    this.persist();
    return this;
  }

  persist() {
    const json = JSON.stringify(this.state);
    fs.writeFileSync(this.tmpFile, json);
    fs.renameSync(this.tmpFile, this.file);
  }

  // Run a mutation to completion with no other mutation interleaved, and write
  // it to disk before the caller sees the result.
  write(fn) {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  createOrganizer({ name, email, passwordHash, salt, slug, timezone, event }) {
    return this.write(() => {
      if (this.state.organizers.some((o) => o.email.toLowerCase() === email.toLowerCase())) {
        return { ok: false, code: "email_taken" };
      }
      if (this.state.organizers.some((o) => o.slug === slug)) {
        return { ok: false, code: "slug_taken" };
      }
      const organizer = {
        id: crypto.randomBytes(8).toString("hex"),
        name,
        email,
        passwordHash,
        salt,
        slug,
        timezone,
        event,
        createdAt: Date.now(),
      };
      this.state.organizers.push(organizer);
      this.persist();
      return { ok: true, organizer };
    });
  }

  updateEvent(organizerId, patch) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      organizer.event = { ...organizer.event, ...patch };
      this.persist();
      return { ok: true, organizer };
    });
  }

  updateOrganizer(organizerId, patch) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      Object.assign(organizer, patch);
      this.persist();
      return { ok: true, organizer };
    });
  }

  // The authoritative double-booking check: overlap test and insert happen
  // inside the same locked step, and the state file is on disk before this returns.
  createBooking({ organizerId, startMs, endMs, guestName, guestEmail, guestNote }) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const conflict = this.state.bookings.some(
        (b) => b.organizerId === organizerId && b.status !== "cancelled" && b.startMs < endMs && startMs < b.endMs
      );
      if (conflict) return { ok: false, code: "conflict" };
      const booking = {
        id: crypto.randomBytes(10).toString("hex"),
        organizerId,
        startMs,
        endMs,
        guestName,
        guestEmail,
        guestNote: guestNote || "",
        status: "confirmed",
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: "",
        rescheduledAt: null,
        rescheduledBy: null,
        previousStartMs: null,
        previousEndMs: null,
        createdAt: Date.now(),
      };
      this.state.bookings.push(booking);
      this.persist();
      return { ok: true, booking };
    });
  }

  // A cancelled booking keeps its record (id, guest, history) but stops holding
  // its slot: every availability check must treat status "cancelled" as free.
  cancelBooking(bookingId, { by = "guest", reason = "" } = {}) {
    return this.write(() => {
      const booking = this.state.bookings.find((b) => b.id === bookingId);
      if (!booking) return { ok: false, code: "not_found" };
      if (booking.status === "cancelled") return { ok: true, booking, already: true };
      booking.status = "cancelled";
      booking.cancelledAt = Date.now();
      booking.cancelledBy = String(by || "guest").slice(0, 20);
      booking.cancellationReason = String(reason || "").slice(0, 500);
      this.persist();
      return { ok: true, booking };
    });
  }

  // Move a booking to a new slot. The same id is kept so the guest's confirmation
  // link and calendar file stay valid. The conflict test ignores the booking
  // being moved (its old slot is being freed) and cancelled bookings. Check and
  // update happen inside one locked step: when a reschedule and another guest's
  // booking race for the same slot, exactly one wins.
  rescheduleBooking(bookingId, { startMs, endMs, by = "guest" } = {}) {
    return this.write(() => {
      const booking = this.state.bookings.find((b) => b.id === bookingId);
      if (!booking) return { ok: false, code: "not_found" };
      if (booking.status === "cancelled") return { ok: false, code: "cancelled" };
      if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || endMs <= startMs) {
        return { ok: false, code: "bad_slot" };
      }
      const conflict = this.state.bookings.some(
        (b) =>
          b.id !== bookingId &&
          b.organizerId === booking.organizerId &&
          b.status !== "cancelled" &&
          b.startMs < endMs &&
          startMs < b.endMs
      );
      if (conflict) return { ok: false, code: "conflict" };
      if (booking.startMs !== startMs) {
        booking.previousStartMs = booking.startMs;
        booking.previousEndMs = booking.endMs;
        booking.rescheduledAt = Date.now();
        booking.rescheduledBy = String(by || "guest").slice(0, 20);
      }
      booking.startMs = startMs;
      booking.endMs = endMs;
      this.persist();
      return { ok: true, booking };
    });
  }

  appendOutbox(entry) {
    return this.write(() => {
      this.state.outbox.push(entry);
      if (this.state.outbox.length > 500) this.state.outbox.splice(0, this.state.outbox.length - 500);
      this.persist();
      return entry;
    });
  }

  updateOutbox(id, patch) {
    return this.write(() => {
      const entry = this.state.outbox.find((e) => e.id === id);
      if (!entry) return { ok: false };
      Object.assign(entry, patch);
      this.persist();
      return { ok: true, entry };
    });
  }

  findOrganizerBySlug(slug) {
    return this.state.organizers.find((o) => o.slug === slug) || null;
  }

  findOrganizerByEmail(email) {
    const needle = String(email || "").toLowerCase();
    return this.state.organizers.find((o) => o.email.toLowerCase() === needle) || null;
  }

  findBooking(id) {
    return this.state.bookings.find((b) => b.id === id) || null;
  }

  bookingsFor(organizerId) {
    return this.state.bookings.filter((b) => b.organizerId === organizerId);
  }
}

module.exports = { Store };
