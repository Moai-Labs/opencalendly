// Confirmation emails. Two modes:
//  - SMTP configured (SMTP_HOST/SMTP_PORT env): send through a minimal SMTP client.
//  - Not configured: the email is queued in the organizer-visible outbox, and the
//    dashboard says so plainly. No silent pretend-delivery.
"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const time = require("./time");

const MAIL_FROM = process.env.MAIL_FROM || "no-reply@opencalendly.example";

function smtpConfig() {
  if (!process.env.SMTP_HOST) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  return {
    host: process.env.SMTP_HOST,
    port,
    // Implicit TLS on 465; otherwise STARTTLS unless SMTP_INSECURE is set.
    implicitTls: port === 465,
    starttls: port !== 465 && !process.env.SMTP_INSECURE,
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
  };
}

// Header values must never carry CR or LF: a crafted name, event title or
// address could otherwise inject headers or smuggle SMTP commands into the
// session, or terminate DATA early. Everything that lands in a header goes
// through this.
function headerSafe(value) {
  return String(value ?? "").replace(/\r\n?|\n/g, " ").trim();
}

// The event a booking refers to. The booking's own snapshot wins — deleting or
// renaming the type must not rewrite what was booked — then the caller's
// resolved type, then the live type if it still exists. A missing type never
// becomes a different one: the label is a plain "Booking".
function bookedEventName(organizer, booking, event) {
  if (booking.eventType && booking.eventType.name) return booking.eventType.name;
  if (event && event.name) return event.name;
  const type = (organizer.eventTypes || []).find((t) => t.id === booking.eventTypeId);
  if (type) return type.name;
  // The pre-event-types shape, which only unmigrated data and ad-hoc
  // constructions can still have.
  if (organizer.event && organizer.event.name) return organizer.event.name;
  return "Booking";
}

// `event` is the event type the booking belongs to (an organizer may have
// several); callers resolve it from the booking's eventTypeId.
function buildGuestConfirmation({ organizer, booking, baseUrl, guestZone, event }) {
  const eventName = headerSafe(bookedEventName(organizer, booking, event));
  const organizerName = headerSafe(organizer.name);
  const when =
    `Your time: ${time.describeInZone(booking.startMs, guestZone)}\n` +
    `Organizer's time: ${time.describeInZone(booking.startMs, organizer.timezone)}`;
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: booking.guestEmail,
    subject: `Confirmed: ${eventName} with ${organizerName}`,
    text:
      `Hi ${booking.guestName},\n\n` +
      `Your booking is confirmed.\n\n${when}\n` +
      `Calendar file: ${baseUrl}/cal/${booking.id}.ics\n` +
      `Manage or view: ${baseUrl}/b/${organizer.slug}/confirmed/${booking.id}\n\n` +
      `Note: this booking does not check the organizer's external calendars.\n`,
  };
}

function buildOrganizerNotification({ organizer, booking, baseUrl, guestZone, event }) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: organizer.email,
    subject: `New booking: ${headerSafe(booking.guestName)}`,
    text:
      `New booking for ${bookedEventName(organizer, booking, event)}.\n` +
      `Guest: ${booking.guestName} <${booking.guestEmail}>\n` +
      `Your time: ${time.describeInZone(booking.startMs, organizer.timezone)}\n` +
      `Guest's stated zone: ${guestZone} (${time.describeInZone(booking.startMs, guestZone)})\n` +
      `Details: ${baseUrl}/dashboard\n` +
      (booking.guestNote ? `Note from guest: ${booking.guestNote}\n` : ""),
  };
}

function buildGuestCancellation({ organizer, booking, baseUrl, guestZone }) {
  const when = `Your time: ${time.describeInZone(booking.startMs, guestZone)}\n` +
    `Organizer's time: ${time.describeInZone(booking.startMs, organizer.timezone)}`;
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: booking.guestEmail,
    subject: `Cancelled: ${headerSafe(bookedEventName(organizer, booking))} with ${headerSafe(organizer.name)}`,
    text:
      `Hi ${booking.guestName},\n\n` +
      `Your booking has been cancelled. The slot is free again.\n\n${when}\n` +
      (booking.cancellationReason ? `Reason: ${booking.cancellationReason}\n` : "") +
      `Book again: ${baseUrl}/b/${organizer.slug}\n` +
      `View: ${baseUrl}/b/${organizer.slug}/confirmed/${booking.id}\n`,
  };
}

function buildOrganizerCancellation({ organizer, booking, baseUrl, guestZone }) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: organizer.email,
    subject: `Booking cancelled: ${headerSafe(booking.guestName)}`,
    text:
      `The booking for ${bookedEventName(organizer, booking)} was cancelled.\n` +
      `Guest: ${booking.guestName} <${booking.guestEmail}>\n` +
      `Was: ${time.describeInZone(booking.startMs, organizer.timezone)}\n` +
      `Cancelled by: ${booking.cancelledBy}\n` +
      (booking.cancellationReason ? `Reason: ${booking.cancellationReason}\n` : "") +
      `Details: ${baseUrl}/dashboard\n`,
  };
}

function buildGuestRescheduled({ organizer, booking, baseUrl, guestZone }) {
  const when = `Your new time: ${time.describeInZone(booking.startMs, guestZone)}\n` +
    `Organizer's time: ${time.describeInZone(booking.startMs, organizer.timezone)}`;
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: booking.guestEmail,
    subject: `Rescheduled: ${headerSafe(bookedEventName(organizer, booking))} with ${headerSafe(organizer.name)}`,
    text:
      `Hi ${booking.guestName},\n\n` +
      `Your booking has been moved.\n\n${when}\n` +
      (booking.previousStartMs ? `Was: ${time.describeInZone(booking.previousStartMs, guestZone)}\n` : "") +
      `Calendar file: ${baseUrl}/cal/${booking.id}.ics\n` +
      `Manage or view: ${baseUrl}/b/${organizer.slug}/confirmed/${booking.id}\n`,
  };
}

function buildOrganizerRescheduled({ organizer, booking, baseUrl, guestZone }) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    organizerId: organizer.id,
    to: organizer.email,
    subject: `Booking rescheduled: ${headerSafe(booking.guestName)}`,
    text:
      `A booking for ${bookedEventName(organizer, booking)} was moved.\n` +
      `Guest: ${booking.guestName} <${booking.guestEmail}>\n` +
      `Now: ${time.describeInZone(booking.startMs, organizer.timezone)}\n` +
      (booking.previousStartMs ? `Was: ${time.describeInZone(booking.previousStartMs, organizer.timezone)}\n` : "") +
      `Details: ${baseUrl}/dashboard\n`,
  };
}

class Mailer {
  constructor(store, config) {
    this.store = store;
    this.config = config || smtpConfig();
  }

  get configured() {
    return Boolean(this.config);
  }

  // Queue the email (synchronously persisted), then attempt delivery in the
  // background. The booking never waits on the network.
  enqueue(entry) {
    return this.store
      .appendOutbox({ ...entry, status: "queued", createdAt: Date.now() })
      .then((saved) => {
        if (this.config) {
          smtpSession(this.config, saved)
            .then(() => this.store.updateOutbox(saved.id, { status: "sent", sentAt: Date.now() }))
            .catch((err) => {
              this.store.updateOutbox(saved.id, { status: "failed", error: String(err.message || err).slice(0, 200) });
              console.error(`mailer: delivery to ${saved.to} failed: ${err.message || err}`);
            });
        }
        return saved;
      });
  }
}

// --- Minimal SMTP client -----------------------------------------------------
// Speaks enough of RFC 5321 for one message: greeting, EHLO, optional
// STARTTLS, optional AUTH LOGIN, MAIL, RCPT, DATA, QUIT.

// Read one SMTP reply: multiline replies end with a line like "250 ..." (a code
// followed by a space); continuation lines look like "250-...".
function readReply(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        socket.destroy();
        reject(new Error("SMTP reply timed out"));
      }
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      lines.pop(); // trailing empty piece after the final \r\n (or partial line)
      for (const line of lines) {
        const m = /^(\d{3})([ -])/.exec(line);
        if (!m) continue;
        if (m[2] === " ") {
          done = true;
          clearTimeout(timer);
          socket.off("data", onData);
          resolve({ code: Number(m[1]), text: buffer });
          break;
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    socket.once("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error("SMTP connection closed unexpectedly"));
      }
    });
  });
}

function sendLine(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line + "\r\n", (err) => (err ? reject(err) : resolve()));
  });
}

async function smtpSession(cfg, mail) {
  const socket = cfg.implicitTls
    ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
    : net.connect({ host: cfg.host, port: cfg.port });
  await new Promise((resolve, reject) => {
    socket.once(cfg.implicitTls ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });
  let active = socket;

  const expect = async (code) => {
    const reply = await readReply(active);
    if (reply.code !== code) {
      throw new Error(`SMTP: expected ${code}, got ${reply.code}: ${reply.text.trim().slice(0, 200)}`);
    }
    return reply;
  };
  const hello = async () => {
    await sendLine(active, "EHLO opencalendly");
    return (await expect(250)).text;
  };

  try {
    await expect(220);
    let ehlo = await hello();
    if (cfg.starttls) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error("SMTP server does not advertise STARTTLS");
      await sendLine(active, "STARTTLS");
      await expect(220);
      active = new tls.connect({ socket, servername: cfg.host });
      await new Promise((resolve, reject) => {
        active.once("secureConnect", resolve);
        active.once("error", reject);
      });
      ehlo = await hello();
    }
    if (cfg.user) {
      await sendLine(active, "AUTH LOGIN");
      await expect(334);
      await sendLine(active, Buffer.from(cfg.user).toString("base64"));
      await expect(334);
      await sendLine(active, Buffer.from(cfg.pass || "").toString("base64"));
      await expect(235);
    }
    await sendLine(active, `MAIL FROM:<${MAIL_FROM}>`);
    await expect(250);
    await sendLine(active, `RCPT TO:<${headerSafe(mail.to)}>`);
    await expect(250);
    await sendLine(active, "DATA");
    await expect(354);
    let message =
      `From: OpenCalendly <${MAIL_FROM}>\r\n` +
      `To: <${headerSafe(mail.to)}>\r\n` +
      `Subject: ${headerSafe(mail.subject)}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `\r\n` +
      // Dot-stuffing per RFC 5321 4.5.2, and normalize newlines.
      mail.text.replace(/(?:\r\n|\r|\n)/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    if (!message.endsWith("\r\n")) message += "\r\n";
    await sendLine(active, message);
    // The message ends with a lone dot line, which is what closes DATA.
    await sendLine(active, ".");
    await expect(250);
    await sendLine(active, "QUIT");
    await new Promise((resolve) => {
      active.once("close", resolve);
      setTimeout(() => {
        active.destroy();
        resolve();
      }, 5000);
    });
  } finally {
    socket.destroy();
  }
}

function deliver(cfg, mail) {
  return smtpSession(cfg, mail);
}

module.exports = {
  Mailer,
  buildGuestConfirmation,
  buildOrganizerNotification,
  buildGuestCancellation,
  buildOrganizerCancellation,
  buildGuestRescheduled,
  buildOrganizerRescheduled,
  smtpConfig,
  MAIL_FROM,
};
