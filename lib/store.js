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
    payments: [],
  };
}

// One event type as stored on an organizer. Availability and duration live
// here since step 3, when event types became a list (free tier: one, paid: up
// to three); before that an organizer carried a single `event` object.
function makeEventType(event, createdAt) {
  return {
    id: crypto.randomBytes(6).toString("hex"),
    name: String(event.name || "Event").slice(0, 60),
    durationMinutes: event.durationMinutes,
    availability: event.availability || {},
    createdAt: createdAt || Date.now(),
  };
}

// Upgrade an older state shape in memory: a single `event` becomes a one-item
// `eventTypes` list; bookings without an event type fall back to the first one
// at read time. The migrated state is persisted by init() right after this.
function normalize(parsed) {
  const fresh = freshState();
  const organizers = (Array.isArray(parsed.organizers) ? parsed.organizers : []).map((o) => {
    if (!o || typeof o !== "object") return o;
    if (!Array.isArray(o.eventTypes)) {
      o.eventTypes = o.event ? [makeEventType(o.event, o.createdAt)] : [];
      delete o.event;
    }
    return o;
  });
  return {
    meta: {
      version: 1,
      sessionSecret: typeof parsed.meta?.sessionSecret === "string" ? parsed.meta.sessionSecret : fresh.meta.sessionSecret,
    },
    organizers,
    bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
    outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : [],
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
        eventTypes: [makeEventType(event)],
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
      // Step 1 kept the single event on the organizer; since event types became
      // a list this updates the first one, which is the same event.
      const first = (organizer.eventTypes || [])[0];
      if (!first) return { ok: false, code: "not_found" };
      Object.assign(first, patch);
      this.persist();
      return { ok: true, organizer };
    });
  }

  // --- event types (the paid tier allows more than one) ----------------------

  addEventType(organizerId, event) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      organizer.eventTypes = organizer.eventTypes || [];
      const type = makeEventType(event);
      organizer.eventTypes.push(type);
      this.persist();
      return { ok: true, eventType: type };
    });
  }

  updateEventType(organizerId, eventTypeId, patch) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const type = (organizer.eventTypes || []).find((t) => t.id === eventTypeId);
      if (!type) return { ok: false, code: "not_found" };
      Object.assign(type, patch);
      this.persist();
      return { ok: true, eventType: type };
    });
  }

  deleteEventType(organizerId, eventTypeId) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const list = organizer.eventTypes || [];
      if (!list.some((t) => t.id === eventTypeId)) return { ok: false, code: "not_found" };
      if (list.length <= 1) return { ok: false, code: "last_event_type" };
      organizer.eventTypes = list.filter((t) => t.id !== eventTypeId);
      this.persist();
      return { ok: true };
    });
  }

  // --- test payments ----------------------------------------------------------

  // Grant paid access for one verified payment. Runs under the same lock as
  // every other mutation, so a transaction hash can only ever be redeemed once
  // even if two requests race with the same hash.
  grantTestPayment({ organizerId, txHash, ref, amountMinor, paidUntilMs }) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const hash = String(txHash).toLowerCase();
      if (this.state.payments.some((p) => p.txHash === hash)) {
        return { ok: false, code: "already_used" };
      }
      const payment = {
        id: crypto.randomBytes(8).toString("hex"),
        organizerId,
        txHash: hash,
        ref,
        amountMinor: String(amountMinor),
        paidAt: Date.now(),
      };
      this.state.payments.push(payment);
      const previous = Number(organizer.paidUntil) || 0;
      organizer.paidUntil = Math.max(previous, Date.now()) + Number(paidUntilMs);
      payment.paidUntilMs = organizer.paidUntil;
      this.persist();
      return { ok: true, payment, organizer };
    });
  }

  findPaymentByTxHash(txHash) {
    const hash = String(txHash || "").toLowerCase();
    return this.state.payments.find((p) => p.txHash === hash) || null;
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
  createBooking({ organizerId, eventTypeId, startMs, endMs, guestName, guestEmail, guestNote }) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const conflict = this.state.bookings.some(
        (b) => b.organizerId === organizerId && b.startMs < endMs && startMs < b.endMs
      );
      if (conflict) return { ok: false, code: "conflict" };
      const booking = {
        id: crypto.randomBytes(10).toString("hex"),
        organizerId,
        eventTypeId: eventTypeId || null,
        startMs,
        endMs,
        guestName,
        guestEmail,
        guestNote: guestNote || "",
        createdAt: Date.now(),
      };
      this.state.bookings.push(booking);
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

  // The event type a page or booking refers to. With an id, only an exact
  // match counts (so callers can reject unknown ids); without one, the first
  // event type stands in — that also covers bookings saved before event types
  // existed.
  eventTypeOf(organizer, eventTypeId) {
    const list = (organizer && organizer.eventTypes) || [];
    if (eventTypeId) return list.find((t) => t.id === eventTypeId) || null;
    return list[0] || null;
  }

  bookingsFor(organizerId) {
    return this.state.bookings.filter((b) => b.organizerId === organizerId);
  }
}

module.exports = { Store };
