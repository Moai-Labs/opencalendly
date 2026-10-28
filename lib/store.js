// Persistent storage: one JSON file in the data directory, written atomically
// (temp file + rename) on every mutation. All mutations serialize through a
// single promise chain, so a booking's conflict check and write happen together
// under the lock — that is the double-booking protection.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const plans = require("./plans");
const { normalizeCalendarCheck } = require("./calendarcheck");

function freshState() {
  return {
    meta: { version: 1, sessionSecret: crypto.randomBytes(32).toString("hex") },
    organizers: [],
    bookings: [],
    outbox: [],
    payments: [],
    intents: [],
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

// Upgrade an older state shape in memory. A single `event` becomes a one-item
// `eventTypes` list; bookings saved before event types existed get the id of
// the migrated type and a snapshot of its name and duration, so their pages
// and calendar files keep showing the event that was booked even if that type
// is later edited or deleted. The migrated state is persisted by init().
function normalize(parsed) {
  const fresh = freshState();
  const organizers = (Array.isArray(parsed.organizers) ? parsed.organizers : []).map((o) => {
    if (!o || typeof o !== "object") return o;
    if (!Array.isArray(o.eventTypes)) {
      o.eventTypes = o.event ? [makeEventType(o.event, o.createdAt)] : [];
      delete o.event;
    }
    if (o.calendar === undefined) o.calendar = null;
    return o;
  });
  const byId = new Map(organizers.map((o) => [o.id, o]));
  const bookings = (Array.isArray(parsed.bookings) ? parsed.bookings : []).map((b) => {
    if (!b || typeof b !== "object") return b;
    if (b.calendarCheck === undefined) b.calendarCheck = null; // kept per booking since the external-calendar step
    if (b.eventType && b.eventType.name) return b;
    const organizer = byId.get(b.organizerId);
    if (!organizer) return b;
    const type = (organizer.eventTypes || []).find((t) => t.id === b.eventTypeId) || organizer.eventTypes[0];
    if (!type) return b;
    b.eventTypeId = type.id;
    b.eventType = { name: type.name, durationMinutes: type.durationMinutes };
    return b;
  });
  return {
    meta: {
      version: 1,
      sessionSecret: typeof parsed.meta?.sessionSecret === "string" ? parsed.meta.sessionSecret : fresh.meta.sessionSecret,
    },
    organizers,
    bookings,
    outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
    payments: Array.isArray(parsed.payments) ? parsed.payments : [],
    intents: Array.isArray(parsed.intents) ? parsed.intents : [],
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
    } catch (err) {
      // Only a missing file is a first boot. Any other read failure (permissions,
      // I/O, the path being something else entirely) must stop startup: persisting
      // an empty state over a file we simply could not read would lose every
      // organizer, booking and payment.
      if (err.code !== "ENOENT") throw err;
      raw = null;
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
      // The tier limit is authoritative here inside the locked mutation: a
      // pre-check in the route cannot see mutations queued behind this one, so
      // two simultaneous additions could otherwise both pass it.
      const limit = plans.eventTypeLimit(organizer);
      if (organizer.eventTypes.length >= limit) {
        return { ok: false, code: "limit_reached", limit };
      }
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

  // Create a server-issued payment intent bound to the authenticated organizer
  // and the wallet address they will pay from. The intent is the only thing
  // tying a transfer to an account: the amount is public and identical for
  // every payment, so an observer could otherwise redeem another user's
  // transaction first.
  createPaymentIntent(organizerId, senderAddress) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const intent = plans.newIntent(organizerId, senderAddress);
      this.state.intents.push(intent);
      this.persist();
      return { ok: true, intent };
    });
  }

  getPaymentIntent(intentId) {
    return this.state.intents.find((i) => i.id === intentId) || null;
  }

  // Consume one intent with one transaction and grant the 30 days in a single
  // locked step. Every precondition is re-checked here — the intent belongs to
  // this organizer, is unconsumed and unexpired, and the transaction hash has
  // never been redeemed — so racing requests and cross-account redemptions
  // both fail closed. The on-chain verification itself happens before this is
  // called; what this guards is access.
  consumePaymentIntent({ intentId, organizerId, txHash }) {
    return this.write(() => {
      const intent = this.state.intents.find((i) => i.id === intentId);
      if (!intent) return { ok: false, code: "intent_not_found" };
      if (intent.organizerId !== organizerId) return { ok: false, code: "intent_not_found" }; // never leak another account's intent
      if (intent.consumedAt) return { ok: false, code: "intent_used" };
      if (Number(intent.expiresAt) < Date.now()) return { ok: false, code: "intent_expired" };
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      const hash = String(txHash).toLowerCase();
      if (this.state.payments.some((p) => p.txHash === hash)) {
        return { ok: false, code: "already_used" };
      }
      const payment = {
        id: crypto.randomBytes(8).toString("hex"),
        organizerId,
        intentId,
        txHash: hash,
        amountMinor: intent.amountMinor,
        paidAt: Date.now(),
      };
      intent.consumedAt = Date.now();
      intent.txHash = hash;
      this.state.payments.push(payment);
      organizer.paidUntil = plans.grantUntil(organizer.paidUntil);
      payment.paidUntilMs = organizer.paidUntil;
      this.persist();
      return { ok: true, payment, organizer };
    });
  }

  findPaymentByTxHash(txHash) {
    const hash = String(txHash || "").toLowerCase();
    return this.state.payments.find((p) => p.txHash === hash) || null;
  }

  // --- the connected external calendar (read-only) ----------------------------

  // One organizer, one calendar feed. The URL is the calendar owner's secret
  // iCal address; it is stored but the app never shows it in full.
  setCalendarFeed(organizerId, { url, name }) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      organizer.calendar = {
        url: String(url).trim(),
        name: String(name || "").slice(0, 80),
        connectedAt: Date.now(),
      };
      this.persist();
      return { ok: true, calendar: organizer.calendar };
    });
  }

  clearCalendarFeed(organizerId) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      organizer.calendar = null;
      this.persist();
      return { ok: true };
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
  // `event` is the type being booked; its name and duration are snapshotted onto
  // the booking so deleting or renaming the type later cannot rewrite what the
  // guest actually booked.
  createBooking({ organizerId, eventTypeId, event, startMs, endMs, guestName, guestEmail, guestNote, calendarCheck }) {
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
        eventTypeId: eventTypeId || null,
        eventType: event ? { name: event.name, durationMinutes: event.durationMinutes } : null,
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
        // What the external-calendar check actually did when this booking was
        // made (or last rescheduled): pages, emails and calendar files speak
        // from this record, not the organizer's current connection state.
        calendarCheck: normalizeCalendarCheck(calendarCheck),
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
  rescheduleBooking(bookingId, { startMs, endMs, by = "guest", calendarCheck } = {}) {
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
      // The new time was re-checked against the calendar as it stands now;
      // the booking's claim moves to that outcome.
      if (calendarCheck !== undefined) booking.calendarCheck = normalizeCalendarCheck(calendarCheck);
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

  // Everything we hold about one organizer, minus what only the app needs
  // (password hash and salt never leave the store). Booking records are copied
  // so callers cannot mutate live state.
  exportOrganizerData(organizerId) {
    const organizer = this.state.organizers.find((o) => o.id === organizerId);
    if (!organizer) return null;
    const { passwordHash, salt, ...organizerData } = organizer;
    return {
      exportedAt: new Date().toISOString(),
      organizer: organizerData,
      bookings: JSON.parse(
        JSON.stringify(this.state.bookings.filter((b) => b.organizerId === organizerId))
      ),
      outbox: JSON.parse(
        JSON.stringify(
          this.state.outbox.filter((e) => e.organizerId === organizerId)
        )
      ),
    };
  }

  // Delete an organizer and everything tied to them. Booking records are kept
  // as anonymous stubs so a guest's calendar file and confirmation link return
  // a clear "cancelled" state rather than a 404 — but the guest's name, email
  // and note are gone, because the organizer's data must leave with them.
  deleteOrganizer(organizerId) {
    return this.write(() => {
      const organizer = this.state.organizers.find((o) => o.id === organizerId);
      if (!organizer) return { ok: false, code: "not_found" };
      this.state.organizers = this.state.organizers.filter((o) => o.id !== organizerId);
      for (const b of this.state.bookings) {
        if (b.organizerId !== organizerId) continue;
        b.status = "cancelled";
        b.cancelledAt = Date.now();
        b.cancelledBy = "organizer_deleted";
        b.guestName = "";
        b.guestEmail = "";
        b.guestNote = "";
        b.rescheduledAt = null;
        b.rescheduledBy = null;
        b.previousStartMs = null;
        b.previousEndMs = null;
      }
      this.state.outbox = this.state.outbox.filter((e) => e.organizerId !== organizerId);
      this.persist();
      return { ok: true };
    });
  }
}

module.exports = { Store };
