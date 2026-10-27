// The HTTP app: routing, sessions, forms, and the booking flow.
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");

const { Store } = require("./store");
const slots = require("./slots");
const time = require("./time");
const ics = require("./ics");
const { Mailer, buildGuestConfirmation, buildOrganizerNotification, smtpConfig } = require("./mailer");
const views = require("./views");

const SESSION_COOKIE = "oc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const BOOKING_DAYS_AHEAD = 14;

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
    const flash = ctx.query.get("saved") ? "Saved." : null;
    html(
      ctx.res,
      200,
      views.dashboardPage({
        organizer,
        baseUrl: ctx.baseUrl,
        bookings: store.bookingsFor(organizer.id),
        outbox: store.state.outbox.filter((e) => e.organizerId === organizer.id).slice(-10),
        mailConfigured: mailer.configured,
        flash,
      })
    );
  });

  route("POST", "/availability", async (ctx) => {
    const organizerId = readSession(ctx.req);
    const organizer = store.state.organizers.find((o) => o.id === organizerId);
    if (!organizer) return redirect(ctx.res, "/login");

    const form = ctx.form;
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

  // --- public booking flow ---------------------------------------------------

  route("GET", "/b/:slug", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist (or the link has a typo)."));
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    const days = slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD);
    const requested = ctx.query.get("date");
    const selectedDate =
      (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && (days.some((d) => d.date === requested) ? requested : null)) ||
      (days.length ? days[0].date : time.localDate(organizer.timezone, Date.now()));
    html(
      ctx.res,
      200,
      views.bookingPage({ organizer, baseUrl: ctx.baseUrl, days, selectedDate, guestZone })
    );
  });

  route("GET", "/b/:slug/new", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const startMs = Date.parse(ctx.query.get("start") || "");
    if (!Number.isFinite(startMs)) return redirect(ctx.res, `/b/${organizer.slug}`);
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    if (!slots.isRealOpenSlot(organizer, store.state.bookings, startMs, Date.now())) {
      return html(
        ctx.res,
        409,
        views.bookingPage({
          organizer,
          baseUrl: ctx.baseUrl,
          days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD),
          selectedDate: time.localDate(guestZone, Math.max(startMs, Date.now())),
          guestZone,
          error: "That time was just taken or is no longer offered. Pick another slot below.",
        })
      );
    }
    html(
      ctx.res,
      200,
      views.bookingFormPage({ organizer, startMs, guestZone })
    );
  });

  route("POST", "/b/:slug/book", async (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const guestZone = guestZoneOr(ctx.form.tz, organizer);
    if (rateLimited(ctx.ip)) {
      return html(ctx.res, 429, views.errorPage("Too many attempts from this address; try again later."));
    }
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
          startMs: Number.isFinite(startMs) ? startMs : Date.now(),
          guestZone,
          values: ctx.form,
          error: !Number.isFinite(startMs) ? "That slot is no longer offered; pick another time." : "Please give your name and a valid email address.",
        })
      );
    }
    // Cheap pre-check (slot is real and open), then the authoritative check and
    // insert happen together under the store lock inside createBooking.
    if (!slots.isRealOpenSlot(organizer, store.state.bookings, startMs, Date.now()) || startMs < Date.now() - 60000) {
      return html(
        ctx.res,
        409,
        views.bookingPage({
          organizer,
          baseUrl: ctx.baseUrl,
          days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD),
          selectedDate: time.localDate(guestZone, Math.max(startMs, Date.now())),
          guestZone,
          error: "That time was just taken or is no longer offered. Pick another slot below.",
        })
      );
    }
    const endMs = startMs + organizer.event.durationMinutes * 60000;
    const result = await store.createBooking({ organizerId: organizer.id, startMs, endMs, guestName, guestEmail, guestNote });
    if (!result.ok) {
      if (result.code === "conflict") {
        return html(
          ctx.res,
          409,
          views.bookingPage({
            organizer,
            baseUrl: ctx.baseUrl,
            days: slots.openSlots(organizer, store.state.bookings, Date.now(), BOOKING_DAYS_AHEAD),
            selectedDate: time.localDate(guestZone, startMs),
            guestZone,
            error: "That time was just taken. Pick another slot below.",
          })
        );
      }
      return html(ctx.res, 500, views.errorPage("Could not save the booking; please try again."));
    }
    const booking = result.booking;
    // Emails queue synchronously, then send in the background; the guest
    // never waits on the mail server.
    await mailer.enqueue(buildGuestConfirmation({ organizer, booking, baseUrl: ctx.baseUrl, guestZone })).catch(() => {});
    await mailer.enqueue(buildOrganizerNotification({ organizer, booking, baseUrl: ctx.baseUrl, guestZone })).catch(() => {});
    redirect(ctx.res, `/b/${organizer.slug}/confirmed/${booking.id}?tz=${encodeURIComponent(guestZone)}`);
  });

  route("GET", "/b/:slug/confirmed/:id", (ctx) => {
    const organizer = store.findOrganizerBySlug(ctx.params.slug);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("This booking page does not exist."));
    const booking = store.findBooking(ctx.params.id);
    if (!booking || booking.organizerId !== organizer.id) {
      return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    }
    const guestZone = guestZoneOr(ctx.query.get("tz"), organizer);
    let emailStatus = "none";
    const guestMail = store.state.outbox.find((e) => e.to === booking.guestEmail && e.subject.includes("Confirmed"));
    if (guestMail) emailStatus = guestMail.status;
    html(
      ctx.res,
      200,
      views.confirmedPage({ organizer, booking, baseUrl: ctx.baseUrl, guestZone, emailStatus })
    );
  });

  route("GET", "/cal/:id.ics", (ctx) => {
    const booking = store.findBooking(ctx.params.id);
    if (!booking) return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    const organizer = store.state.organizers.find((o) => o.id === booking.organizerId);
    if (!organizer) return html(ctx.res, 404, views.notFoundPage("We could not find that booking."));
    icsResponse(ctx.res, ics.bookingIcs({ organizer, booking, baseUrl: ctx.baseUrl, guestZone: organizer.timezone }));
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
