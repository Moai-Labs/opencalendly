"use strict";

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Mailer, buildGuestConfirmation } = require("../lib/mailer");
const { Store } = require("../lib/store");

// A deliberately tiny SMTP server: enough protocol to exercise our client.
function fakeSmtpServer() {
  const seen = { commands: [], message: null };
  const server = net.createServer((socket) => {
    socket.write("220 fake ESMTP\r\n");
    let inData = false;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          } else {
            seen.message = (seen.message || "") + line + "\n";
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
  assert.ok(seen.message.includes("Subject: Confirmed: Intro call with Ada"));
  assert.ok(seen.message.includes("grace@example.com"));
  assert.ok(seen.message.includes("does not check the organizer's external calendars"));

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
