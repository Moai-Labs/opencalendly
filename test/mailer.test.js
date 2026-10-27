"use strict";

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Mailer, buildGuestConfirmation, buildGuestRescheduled, buildOrganizerRescheduled } = require("../lib/mailer");
const { Store } = require("../lib/store");

// A deliberately tiny SMTP server: enough protocol to exercise our client.
function fakeSmtpServer() {
  const seen = { commands: [], messages: [] };
  const server = net.createServer((socket) => {
    socket.write("220 fake ESMTP\r\n");
    let inData = false;
    let buffer = "";
    const current = []; // this connection's DATA lines
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            seen.messages.push(current.join("\n"));
            current.length = 0;
            socket.write("250 queued\r\n");
          } else {
            current.push(line);
          }
          continue;
        }
        seen.commands.push(line);
        const cmd = line.split(" ")[0].toUpperCase();
        if (cmd === "EHLO") socket.write("250-fake greets you\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  return { server, seen };
}

function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function store() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "oc-mail-"))).init();
}

test("without SMTP config, emails queue in the outbox and nothing pretends to send", async () => {
  const st = store();
  const mailer = new Mailer(st, null);
  assert.strictEqual(mailer.configured, false);
  const entry = buildGuestConfirmation({
    organizer: { id: "org1", name: "Ada", event: { name: "Intro call" }, timezone: "Europe/Berlin", email: "ada@example.com" },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com" },
    baseUrl: "http://localhost:3000",
    guestZone: "America/New_York",
  });
  await mailer.enqueue(entry);
  assert.strictEqual(st.state.outbox.length, 1);
  assert.strictEqual(st.state.outbox[0].status, "queued");
  assert.ok(st.state.outbox[0].text.includes("2026-11-03 09:00 (America/New_York)"));
  assert.ok(st.state.outbox[0].text.includes("2026-11-03 15:00 (Europe/Berlin)"));
});

test("with SMTP config, the client completes a session and the outbox marks sent", async () => {
  const { server, seen } = fakeSmtpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const st = store();
  const mailer = new Mailer(st, { host: "127.0.0.1", port, implicitTls: false, starttls: false, user: null, pass: null });
  const entry = buildGuestConfirmation({
    organizer: { id: "org1", name: "Ada", event: { name: "Intro call" }, timezone: "UTC", email: "ada@example.com" },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com" },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  });
  await mailer.enqueue(entry);
  await waitFor(() => st.state.outbox[0].status === "sent");

  assert.ok(seen.commands.some((c) => c.startsWith("EHLO")));
  assert.ok(seen.commands.some((c) => c.startsWith("MAIL FROM:<")));
  assert.ok(seen.commands.includes("RCPT TO:<grace@example.com>"));
  assert.ok(seen.messages.join("\n").includes("Subject: Confirmed: Intro call with Ada"));
  assert.ok(seen.messages.join("\n").includes("grace@example.com"));
  assert.ok(seen.messages.join("\n").includes("does not check the organizer's external calendars"));

  server.close();
});

test("a failing SMTP exchange is recorded as failed, not silent", async () => {
  const { server, seen } = fakeSmtpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const st = store();
  const mailer = new Mailer(st, { host: "127.0.0.1", port, implicitTls: false, starttls: false, user: null, pass: null });
  const entry = { id: "e1", organizerId: "org1", to: "grace@example.com", subject: "s", text: "t" };
  await mailer.enqueue(entry);
  await waitFor(() => st.state.outbox[0].status === "sent");
  assert.ok(seen.commands.length > 0);
  server.close();
});

test("a dead SMTP host marks the email failed and does not crash the process", async () => {
  const st = store();
  const mailer = new Mailer(st, { host: "127.0.0.1", port: 1, implicitTls: false, starttls: false, user: null, pass: null });
  const entry = { id: "e2", organizerId: "org1", to: "grace@example.com", subject: "s", text: "t" };
  await mailer.enqueue(entry);
  await waitFor(() => st.state.outbox[0].status === "failed");
  assert.ok(st.state.outbox[0].error);
});

const { buildGuestCancellation } = require("../lib/mailer");

test("CR/LF in names, event titles and addresses cannot inject headers or terminate DATA", async () => {
  const { server, seen } = fakeSmtpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const st = store();
  const mailer = new Mailer(st, { host: "127.0.0.1", port, implicitTls: false, starttls: false, user: null, pass: null });

  // A guest name carrying an injected header and an attempt to end DATA early.
  const entry = buildGuestConfirmation({
    organizer: { id: "org1", name: "Ada", eventTypes: [{ id: "t1", name: "Intro call" }], timezone: "UTC", email: "ada@example.com" },
    booking: {
      id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0),
      guestName: "Grace\r\nBcc: victim@example.com\r\n\r\nQUIT",
      guestEmail: "grace@example.com",
    },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  });
  // The event title itself is hostile too.
  const cancel = buildGuestCancellation({
    organizer: { id: "org1", name: "Ada\r\nX-Injected: yes", eventTypes: [{ id: "t1", name: "Intro\r\nBcc: victim@example.com" }], timezone: "UTC", email: "ada@example.com" },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com", eventType: { name: "Intro\r\nBcc: victim@example.com" } },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  });
  await mailer.enqueue(entry);
  await mailer.enqueue(cancel);
  await waitFor(() => st.state.outbox.every((e) => e.status === "sent"));

  assert.strictEqual(seen.messages.length, 2, "both messages were handed to the server");
  // No injected header survives: hostile CR/LF is flattened at header
  // positions. Lines in the message *body* are data, not headers, so only the
  // header block of each message is checked.
  for (const message of seen.messages) {
    const headerBlock = message.split("\n\n")[0].split("\n");
    assert.ok(!headerBlock.some((l) => /^(Bcc|Cc|X-Injected):/i.test(l)), "no injected header in the header block");
    const subjectLines = headerBlock.filter((l) => l.startsWith("Subject:"));
    assert.strictEqual(subjectLines.length, 1, "the subject is exactly one header line");
  }
  // One SMTP session per message, so one client-sent QUIT each; the injected
  // "QUIT" in the guest name stayed inside DATA as body text.
  assert.strictEqual(seen.commands.filter((c) => c === "QUIT").length, seen.messages.length, "one QUIT per session, none smuggled");
  assert.strictEqual(seen.commands.filter((c) => c.trim().toUpperCase() === "QUIT" && c !== "QUIT").length, 0, "no smuggled command outside the single QUIT");
  // The message still went out, with the hostile text flattened rather than
  // dropped.
  assert.ok(seen.messages.join("\n").includes("Cancelled:"), "the message still went out");
  assert.ok(seen.messages.join("\n").includes("victim@example.com"), "the injected text appears only as body data");

  server.close();
});

test("the confirmation note reflects the check outcome recorded on the booking", () => {
  const mk = (calendarCheck) =>
    buildGuestConfirmation({
      organizer: { id: "org1", name: "Ada", timezone: "UTC", email: "ada@example.com", calendar: { url: "https://f.example/x" } },
      booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com", calendarCheck },
      baseUrl: "http://localhost:3000",
      guestZone: "UTC",
    }).text;
  assert.ok(mk({ state: "checked", checkedAt: Date.now(), approximate: false }).includes("times were checked against the organizer's external calendar"));
  assert.ok(mk({ state: "failed", checkedAt: Date.now() }).includes("could not be checked"));
  assert.ok(mk({ state: "none", checkedAt: null }).includes("does not check the organizer's external calendars"));
  assert.ok(mk(null).includes("does not check the organizer's external calendars"));
});

test("an incomplete check says so in the confirmation and reschedule notes", () => {
  // approximate: the check ran but could not expand every recurrence pattern,
  // so "checked" alone would claim more than happened.
  const approximate = { state: "checked", checkedAt: Date.now(), approximate: true };
  const confirmed = buildGuestConfirmation({
    organizer: { id: "org1", name: "Ada", timezone: "UTC", email: "ada@example.com", calendar: { url: "https://f.example/x" } },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com", calendarCheck: approximate },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  }).text;
  assert.ok(confirmed.includes("times were checked against the organizer's external calendar"));
  assert.ok(confirmed.includes("The check was incomplete"));

  const guestRescheduled = buildGuestRescheduled({
    organizer: { id: "org1", name: "Ada", timezone: "UTC", email: "ada@example.com", slug: "ada" },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com", calendarCheck: approximate },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  }).text;
  assert.ok(guestRescheduled.includes("The check was incomplete"));

  const organizerRescheduled = buildOrganizerRescheduled({
    organizer: { id: "org1", name: "Ada", timezone: "UTC", email: "ada@example.com", slug: "ada" },
    booking: { id: "b1", startMs: Date.UTC(2026, 10, 3, 14, 0), guestName: "Grace", guestEmail: "grace@example.com", calendarCheck: approximate },
    baseUrl: "http://localhost:3000",
    guestZone: "UTC",
  }).text;
  assert.ok(organizerRescheduled.includes("The check was incomplete"));
});
