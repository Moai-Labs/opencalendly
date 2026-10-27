// The HTTP app: routing, sessions, forms, and the booking flow.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

const { Store } = require("./store");
const slots = require("./slots");
const time = require("./time");
const ics = require("./ics");
const plans = require("./plans");
const payments = require("./payments");
const { Mailer, buildGuestConfirmation, buildOrganizerNotification, smtpConfig } = require("./mailer");
const views = require("./views");

const SESSION_COOKIE = "oc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const BOOKING_DAYS_AHEAD = 14;

// The TEST payment setup. These are test-USDC payments on a public testnet —
// never real money, never revenue. The recipient address is this deployment's
// own receiving address for test payments; without it the upgrade page says
// test payments are not configured rather than pretending anything.
const payConfig = {
  enabled: Boolean(process.env.PAY_TEST_ADDRESS),
  recipient: process.env.PAY_TEST_ADDRESS || "",
  // Base Sepolia test-USDC, decimals 6 — verified live against the RPC when
  // this was built (see context/ and sources.md).
  token: process.env.PAY_TEST_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  rpcUrl: process.env.PAY_TEST_RPC_URL || "https://sepolia.base.org",
  chainName: process.env.PAY_TEST_CHAIN || "Base Sepolia (testnet)",
};

// Parse and validate the event form shared by availability saves and event
// type create/update.
function readEventForm(form) {
  const availability = {};
  let error = null;
  for (let dow = 1; dow <= 7 && !error; dow++) {
    const sRaw = form[`d${dow}_s`];
    const eRaw = form[`d${dow}_e`];
    if (!sRaw && !eRaw) continue; // closed day
    const s = time.parseHm(sRaw);
    const e = time.parseHm(eRaw);
    if (s === null || e === null || e <= s) {
      error = "Some hours are invalid. Use HH:MM, and the end must be after the start.";
      break;
    }
    availability[String(dow)] = [{ s: time.formatMinutes(s), e: time.formatMinutes(e) }];
  }
  const duration = Number(form.duration);
  const eventName = (form.event_name || "").trim().slice(0, 60);
  const timezone = form.timezone && time.isValidZone(form.timezone) ? form.timezone : null;
  if (!error) {
    if (!Number.isInteger(duration) || !slots.DURATION_ALLOWED.includes(duration)) error = "Pick a slot duration from the list.";
    if (!error && !eventName) error = "Give the event a name.";
    if (!error && !timezone) error = "Pick a time zone from the list.";
  }
  return { availability, duration, eventName, timezone, error };
}

// --- helpers -----------------------------------------------------------------

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(text) {
  const out = {};
  for (const pair of new URLSearchParams(text)) out[pair[0]] = pair[1].slice(0, 2000);
  return out;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function html(res, status, text, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(text);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...headers });
  res.end();
}

function icsResponse(res, text) {
  res.writeHead(200, {
    "content-type": "text/calendar; charset=utf-8",
    "content-disposition": `attachment; filename="booking.ics"`,
    "cache-control": "no-store",
  });
  res.end(text);
}

function baseUrlOf(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}

const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function makeSlug() {
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

// --- app ---------------------------------------------------------------------

function createApp(options = {}) {
  const dataDir = options.dataDir || (process.env.DATA_DIR || "/data");
  const store = new Store(dataDir).init();
  const mailer = new Mailer(store, options.mailConfig || smtpConfig());
  // Injectable for tests; production talks to the configured public RPC.
  const rpcCall = options.rpcCall || ((method, params) => payments.jsonRpcCall(payConfig.rpcUrl, method, params));

  // The organizer's tier state as the views need it.
  function planOf(organizer, nowMs = Date.now()) {
    return {
      paid: plans.isPaid(organizer, nowMs),
      limit: plans.eventTypeLimit(organizer, nowMs),
      paidUntil: Number(organizer.paidUntil) || 0,
    };
  }

  // The event type a page refers to. With an `e` parameter the match must be
  // exact; without one, a single-type organizer gets that type and a
  // multi-type organizer gets null (the caller shows the picker).
  function eventFor(organizer, id) {
    if (id) return store.eventTypeOf(organizer, id);
    const types = organizer.eventTypes || [];
    return types.length === 1 ? types[0] : null;
  }

  // Coarse in-memory rate limit for the public booking POST.
  const bookingAttempts = new Map(); // ip -> timestamps
  function rateLimited(ip) {
    const now = Date.now();
    const list = (bookingAttempts.get(ip) || []).filter((t) => now - t < 3600 * 1000);
    list.push(now);
    bookingAttempts.set(ip, list);
    return list.length > 30;
  }

  function signSession(organizerId) {
    const payload = Buffer.from(JSON.stringify({ id: organizerId, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
    const mac = crypto.createHmac("sha256", store.state.meta.sessionSecret).update(payload).digest("base64url");
    return `${payload}.${mac}`;
  }

  function readSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot === -1) return null;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", store.state.meta.sessionSecret).update(payload).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!data.id || typeof data.exp !== "number" || data.exp < Date.now()) return null;
      return data.id;
    } catch {
      return null;
    }
  }

  function sessionCookie(token, clear = false) {
    const parts = [
      `${SESSION_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      clear ? "Max-Age=0" : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    return parts.join("; ");
  }

  // Resolve a guest zone from an explicit parameter; fall back to the
  // organizer's zone so the page is still honest without JavaScript.
  function guestZoneOr(param, organizer) {
    const zone = typeof param === "string" ? param.trim() : "";
    if (zone && time.isValidZone(zone)) return zone;
    return organizer.timezone;
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const regex = new RegExp(
      "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, name) => { names.push(name); return "([^/]+)"; }) + "$"
    );
    routes.push({ method, regex, names, handler });
  };

  // --- public pages ----------------------------------------------------------

  route("GET", "/", (ctx) => html(ctx.res, 200, views.homePage()));

  route("GET", "/healthz", (ctx) => {
    ctx.res.writeHead(200, { "content-type": "text/plain" });
    ctx.res.end("ok\n");
  });

  route("GET", "/signup", (ctx) => html(ctx.res, 200, views.signupPage()));

  route("POST", "/signup", async (ctx) => {
    const form = ctx.form;
    const name = (form.name || "").trim().slice(0, 80);
    const email = (form.email || "").trim().slice(0, 120);
    const password = form.password || "";
    const timezone = form.timezone && time.isValidZone(form.timezone) ? form.timezone : "UTC";
    if (!name) return html(ctx.res, 400, views.signupPage(form, "Please enter your name."));
    if (!validEmail(email)) return html(ctx.res, 400, views.signupPage(form, "Please enter a valid email address."));
    if (password.length < 8 || password.length > 200) {
      return html(ctx.res, 400, views.signupPage(form, "Password must be at least 8 characters."));
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const result = await store.createOrganizer({
      name,
      email,
      passwordHash: hashPassword(password, salt),
      salt,
      slug: makeSlug(),
      timezone,
      event: {
        name: "30 minute meeting",
        durationMinutes: 30,
        availability: slots.defaultAvailability(),
      },
    });
    if (!result.ok) {
      const message = result.code === "email_taken" ? "That email already has an account. Sign in instead." : "Something went wrong; please try again.";
      return html(ctx.res, result.code === "email_taken" ? 400 : 500, views.signupPage(form, message));
    }
    redirect(ctx.res, "/dashboard", { "set-cookie": sessionCookie(signSession(result.organizer.id)) });
  });

  route("GET", "/login", (ctx) => html(ctx.res, 200, views.loginPage()));

  route("POST", "/login", async (ctx) => {
    const email = (ctx.form.email || "").trim().slice(0, 120);
    const password = ctx.form.password || "";
    const organizer = store.findOrganizerByEmail(email);
    if (organizer && password.length <= 200) {
      const attempt = hashPassword(password, organizer.salt);
      const a = Buffer.from(attempt, "hex");
      const b = Buffer.from(organizer.passwordHash, "hex");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return redirect(ctx.res, "/dashboard", { "set-cookie": sessionCookie(signSession(organizer.id)) });
      }
    }
    html(ctx.res, 401, views.loginPage("Wrong email or password.", email));
  });

  route("POST", "/logout", (ctx) => redirect(ctx.res, "/", { "set-cookie": sessionCookie("", true) }));
  route("GET", "/logout", (ctx) => redirect(ctx.res, "/", { "set-cookie": sessionCookie("", true) }));

  // --- organizer -------------------------------------------------------------

  route("GET", "/dashboard", async (ctx) => {
    const organizerId = readSession(ctx.req);
    const organizer = store.state.organizers.find((o) => o.id === organizerId);
    if (!organizer) return redirect(ctx.res, "/login");
    let flash = ctx.query.get("saved") ? "Saved." : null;
    if (ctx.query.get("upgraded")) {
      flash = plans.isPaid(organizer)
        ? "Test payment verified — paid access granted until " + time.describeInZone(organizer.paidUntil, "UTC") + " UTC. Test payments are not revenue."
        : null;
    }
    html(
      ctx.res,
      200,
      views.dashboardPage({
        organizer,
        baseUrl: ctx.baseUrl,
        bookings: store.bookingsFor(organizer.id),
        outbox: store.state.outbox.filter((e) => e.organizerId === organizer.id).slice(-10),
        mailConfigured: mailer.configured,
        plan: planOf(organizer),
        flash,
      })
    );
  });

  route("POST", "/availability", async (ctx) => {
    const organizerId = readSession(ctx.req);
    const organizer = store.state.organizers.find((o) => o.id === organizerId);
    if (!organizer) return redirect(ctx.res, "/login");

    const { availability, duration, eventName, timezone, error } = readEventForm(ctx.form);
    if (error) {
      html(
        ctx.res,
        400,
        views.dashboardPage({
          organizer,
          baseUrl: ctx.baseUrl,
          bookings: store.bookingsFor(organizer.id),
          outbox: store.state.outbox.filter((e) => e.organizerId === organizer.id).slice(-10),
          mailConfigured: mailer.configured,
          plan: planOf(organizer),
          error,
        })
      );
      return;
    }
    await store.updateEvent(organizer.id, {
      name: eventName,
      durationMinutes: duration,
      availability,
    });
    if (timezone !== organizer.timezone) {
      await store.updateOrganizer(organizer.id, { timezone });
    }
    redirect(ctx.res, "/dashboard?saved=1");
  });

  // --- event types (the paid tier allows more than one) ----------------------

  function renderEventForm(ctx, organizer, { eventType = null, values = {}, error = null, status = 200 }) {
    html(ctx.res, status, views.eventTypeFormPage({ organizer, eventType, values, error }));
  }

  route("GET", "/event-types/new", (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    if ((organizer.eventTypes || []).length >= planOf(organizer).limit) {
      return redirect(ctx.res, "/dashboard");
    }
    renderEventForm(ctx, organizer, {});
  });

  route("POST", "/event-types", async (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    // The tier limit is enforced here on the server, not just in the UI.
    if ((organizer.eventTypes || []).length >= planOf(organizer).limit) {
      return html(
        ctx.res,
        403,
        views.dashboardPage({
          organizer,
          baseUrl: ctx.baseUrl,
          bookings: store.bookingsFor(organizer.id),
          outbox: store.state.outbox.filter((e) => e.organizerId === organizer.id).slice(-10),
          mailConfigured: mailer.configured,
          plan: planOf(organizer),
          error: "Your plan's event-type limit is reached. Upgrade to add more.",
        })
      );
    }
    const { availability, duration, eventName, timezone, error } = readEventForm(ctx.form);
    if (error) return renderEventForm(ctx, organizer, { values: ctx.form, error, status: 400 });
    await store.addEventType(organizer.id, { name: eventName, durationMinutes: duration, availability });
    if (timezone !== organizer.timezone) {
      await store.updateOrganizer(organizer.id, { timezone });
    }
    redirect(ctx.res, "/dashboard?saved=1");
  });

  route("GET", "/event-types/:id", (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    const eventType = store.eventTypeOf(organizer, ctx.params.id);
    if (!eventType) return html(ctx.res, 404, views.notFoundPage("That event type does not exist."));
    renderEventForm(ctx, organizer, { eventType });
  });

  route("POST", "/event-types/:id", async (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    const eventType = store.eventTypeOf(organizer, ctx.params.id);
    if (!eventType) return html(ctx.res, 404, views.notFoundPage("That event type does not exist."));
    const { availability, duration, eventName, timezone, error } = readEventForm(ctx.form);
    if (error) return renderEventForm(ctx, organizer, { eventType, values: ctx.form, error, status: 400 });
    await store.updateEventType(organizer.id, eventType.id, { name: eventName, durationMinutes: duration, availability });
    if (timezone !== organizer.timezone) {
      await store.updateOrganizer(organizer.id, { timezone });
    }
    redirect(ctx.res, "/dashboard?saved=1");
  });

  route("POST", "/event-types/:id/delete", async (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    const result = await store.deleteEventType(organizer.id, ctx.params.id);
    const flash = result.ok
      ? "?deleted=1"
      : result.code === "last_event_type"
        ? "?error=" + encodeURIComponent("You need at least one event type; it cannot be deleted.")
        : "";
    redirect(ctx.res, "/dashboard" + flash);
  });

  // --- the paid tier: test payments ------------------------------------------

  // What the upgrade page shows about payments; fmtAmount lives in plans.
  const payView = { ...payConfig, fmtAmount: plans.fmtAmount };

  route("GET", "/upgrade", (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    const plan = planOf(organizer);
    const ref = plans.newRef();
    html(ctx.res, 200, views.upgradePage({ pay: payView, plan, ref, amountMinor: plans.amountForRef(ref) }));
  });

  route("POST", "/upgrade", async (ctx) => {
    const organizer = store.state.organizers.find((o) => o.id === readSession(ctx.req));
    if (!organizer) return redirect(ctx.res, "/login");
    const plan = planOf(organizer);
    const ref = Number(ctx.form.ref);
    const tx = (ctx.form.tx || "").trim();
    const fail = (status, message) =>
      html(ctx.res, status, views.upgradePage({
        pay: payView,
        plan,
        ref: plans.refIsValid(ref) ? ref : plans.newRef(),
        amountMinor: plans.refIsValid(ref) ? plans.amountForRef(ref) : plans.amountForRef(plans.newRef()),
        values: { tx },
        error: message,
      }));
    if (!payConfig.enabled) return fail(400, "Test payments are not configured on this deployment, so nothing can be verified.");
    if (rateLimited(ctx.ip)) return fail(429, "Too many attempts from this address; try again later.");
    if (!plans.refIsValid(ref)) return fail(400, "That payment reference is not valid. Start again from the payment instructions.");
    if (!payments.isTxHash(tx)) return fail(400, "That does not look like a transaction hash. It should be 0x followed by 64 hex characters.");
    const amountMinor = plans.amountForRef(ref);
    const verdict = await payments.verifyTestPayment({
      rpcCall,
      txHash: tx,
      recipient: payConfig.recipient,
      token: payConfig.token,
      expectedAmountMinor: amountMinor,
    });
    if (!verdict.ok) {
      const messages = {
        not_found: "No confirmed transaction with that hash (yet). Transfers need a moment to be confirmed on-chain; try again in a minute.",
        failed: "That transaction failed on-chain; no payment happened.",
        no_matching_transfer: "The transaction exists, but it is not a transfer of the exact amount of test-USDC to our address. Check the payment instructions and try again.",
        bad_input: "That does not look like a transaction hash.",
        rpc_error: "The blockchain check could not run just now; try again shortly.",
      };
      return fail(400, messages[verdict.code] || "The payment could not be verified; try again.");
    }
    const grant = await store.grantTestPayment({
      organizerId: organizer.id,
      txHash: tx,
      ref,
      amountMinor,
      paidUntilMs: plans.GRANT_MS,
    });
    if (!grant.ok) {
      if (grant.code === "already_used") return fail(400, "That transaction has already been used for a grant. Each payment grants once.");
      return fail(500, "The payment verified but could not be recorded; please try again.");
    }
    redirect(ctx.res, "/dashboard?upgraded=1");
  });

  // --- public booking flow ---------------------------------------------------

  route("GET", "/b/:slug", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist (or the link has a typo)."));
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    const paid = plans.isPaid(organizer);
    const event = eventFor(organizer, ctx.query.get("e"));
    if (!event) {
      if (ctx.query.get("e")) return html(ctx.res, 404, views.notFoundPage("That event type does not exist on this booking page."));
      return html(ctx.res, 200, views.eventPickerPage({ organizer, baseUrl: ctx.baseUrl, guestZone }));
    }
    const days = slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD, event);
    const requested = ctx.query.get("date");
    const selectedDate =
      (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && (days.some((d) => d.date === requested) ? requested : null)) ||
      (days.length ? days[0].date : time.localDate(organizer.timezone, Date.now()));
    html(
      ctx.res,
      200,
      views.bookingPage({ organizer, event, baseUrl: ctx.baseUrl, days, selectedDate, guestZone, paid })
    );
  });

  route("GET", "/b/:slug/new", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const event = eventFor(organizer, ctx.query.get("e"));
    if (!event) return redirect(ctx.res, `/b/${organizer.slug}`);
    const startMs = Date.parse(ctx.query.get("start") || "");
    if (!Number.isFinite(startMs)) return redirect(ctx.res, `/b/${organizer.slug}?e=${encodeURIComponent(event.id)}`);
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    if (!slots.isRealOpenSlot(organizer, store.state.bookings, startMs, Date.now(), event)) {
      return html(
        ctx.res,
        409,
        views.bookingPage({
          organizer,
          event,
          baseUrl: ctx.baseUrl,
          days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD, event),
          selectedDate: time.localDate(guestZone, Math.max(startMs, Date.now())),
          guestZone,
          paid: plans.isPaid(organizer),
          error: "That time was just taken or is no longer offered. Pick another slot below.",
        })
      );
    }
    html(
      ctx.res,
      200,
      views.bookingFormPage({ organizer, event, startMs, guestZone, paid: plans.isPaid(organizer) })
    );
  });

  route("POST", "/b/:slug/book", async (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const guestZone = guestZoneOr(ctx.form.tz, organizer);
    if (rateLimited(ctx.ip)) {
      return html(ctx.res, 429, views.errorPage("Too many attempts from this address; try again later."));
    }
    // The event type comes from the form; an explicit id must match, a missing
    // one only stands in when there is exactly one type to pick.
    const event = eventFor(organizer, ctx.form.e || null);
    if (!event) return html(ctx.res, 404, views.notFoundPage("That event type does not exist on this booking page."));
    const startMs = Date.parse(ctx.form.start || "");
    const guestName = (ctx.form.guest_name || "").trim().slice(0, 100);
    const guestEmail = (ctx.form.guest_email || "").trim().slice(0, 120);
    const guestNote = (ctx.form.guest_note || "").trim().slice(0, 500);
    if (!Number.isFinite(startMs) || !guestName || !validEmail(guestEmail)) {
      return html(
        ctx.res,
        400,
        views.bookingFormPage({
          organizer,
          event,
          startMs: Number.isFinite(startMs) ? startMs : Date.now(),
          guestZone,
          paid: plans.isPaid(organizer),
          values: ctx.form,
          error: !Number.isFinite(startMs) ? "That slot is no longer offered; pick another time." : "Please give your name and a valid email address.",
        })
      );
    }
    // Cheap pre-check (slot is real and open), then the authoritative check and
    // insert happen together under the store lock inside createBooking.
    if (!slots.isRealOpenSlot(organizer, store.state.bookings, startMs, Date.now(), event) || startMs < Date.now() - 60000) {
      return html(
        ctx.res,
        409,
        views.bookingPage({
          organizer,
          event,
          baseUrl: ctx.baseUrl,
          days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD, event),
          selectedDate: time.localDate(guestZone, Math.max(startMs, Date.now())),
          guestZone,
          paid: plans.isPaid(organizer),
          error: "That time was just taken or is no longer offered. Pick another slot below.",
        })
      );
    }
    const endMs = startMs + event.durationMinutes * 60000;
    const result = await store.createBooking({ organizerId: organizer.id, eventTypeId: event.id, startMs, endMs, guestName, guestEmail, guestNote });
    if (!result.ok) {
      if (result.code === "conflict") {
        return html(
          ctx.res,
          409,
          views.bookingPage({
            organizer,
            event,
            baseUrl: ctx.baseUrl,
            days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD, event),
            selectedDate: time.localDate(guestZone, startMs),
            guestZone,
            paid: plans.isPaid(organizer),
            error: "That time was just taken. Pick another slot below.",
          })
        );
      }
      return html(ctx.res, 500, views.errorPage("Could not save the booking; please try again."));
    }
    const booking = result.booking;
    // Emails queue synchronously, then send in the background; the guest
    // never waits on the mail server.
    await mailer.enqueue(buildGuestConfirmation({ organizer, booking, baseUrl: ctx.baseUrl, guestZone, event })).catch(() => {});
    await mailer.enqueue(buildOrganizerNotification({ organizer, booking, baseUrl: ctx.baseUrl, guestZone, event })).catch(() => {});
    redirect(ctx.res, `/b/${organizer.slug}/confirmed/${booking.id}?tz=${encodeURIComponent(guestZone)}`);
  });

  route("GET", "/b/:slug/confirmed/:id", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const booking = store.findBooking(ctx.params.id);
    if (!booking || booking.organizerId !== organizer.id) {
      return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    }
    const event = store.eventTypeOf(organizer, booking.eventTypeId);
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    let emailStatus = "none";
    const guestMail = store.state.outbox.find((e) => e.to === booking.guestEmail && e.subject.includes("Confirmed"));
    if (guestMail) emailStatus = guestMail.status;
    html(
      ctx.res,
      200,
      views.confirmedPage({ organizer, event, booking, baseUrl: ctx.baseUrl, guestZone, emailStatus, paid: plans.isPaid(organizer) })
    );
  });

  route("GET", "/cal/:id.ics", (ctx) => {
    const booking = store.findBooking(ctx.params.id);
    if (!booking) return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    const organizer = store.state.organizers.find((o) => o.id === booking.organizerId);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    const event = store.eventTypeOf(organizer, booking.eventTypeId);
    icsResponse(ctx.res, ics.bookingIcs({ organizer, booking, baseUrl: ctx.baseUrl, guestZone: organizer.timezone, event }));
  });

  function dispatch(req, res) {
    const url = new URL(req.url, "http://internal");
    const method = req.method === "HEAD" ? "GET" : req.method;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      return { route: r, params, url };
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    const matched = dispatch(req, res);
    const finish = (status, text) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (!matched) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      return res.end(views.notFoundPage("This page does not exist."));
    }
    Promise.resolve()
      .then(async () => {
        const ctx = {
          req,
          res,
          params: matched.params,
          query: matched.url.searchParams,
          baseUrl: baseUrlOf(req),
          ip:
            (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
            req.socket.remoteAddress ||
            "unknown",
          form: {},
        };
        if (req.method === "POST") {
          const text = await readBody(req);
          const contentType = req.headers["content-type"] || "";
          if (contentType.includes("application/x-www-form-urlencoded")) ctx.form = parseForm(text);
        }
        await matched.route.handler(ctx);
      })
      .catch((err) => {
        console.error(`request error ${req.method} ${req.url}:`, err);
        if (!res.headersSent) html(res, 500, views.errorPage("Something went wrong on our side."));
        else res.end();
      });
  });

  server.keepAliveTimeout = 65000;
  return { server, store, mailer, dataDir };
}

module.exports = { createApp };
