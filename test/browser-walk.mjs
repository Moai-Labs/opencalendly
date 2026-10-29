#!/usr/bin/env node
// A real-browser walk of the flows a user walks, driven with puppeteer.
// Not part of the test suite: run with
//   CHROME_PATH=... LD_LIBRARY_PATH=... node test/browser-walk.mjs <baseUrl> <tag> <feedUrl>
// It walks logged-out (landing, demo booking, .ics) and logged-in (sign-up,
// availability, connect a calendar, the booking-page test, disconnect,
// account deletion) and prints what each page actually said. Copy is
// reported verbatim, not asserted, so the same walk runs against any
// deployment; behaviour (slots hidden, 409 on a busy slot, zones) is
// asserted here.

import puppeteer from "puppeteer";
import fs from "node:fs";
import path from "node:path";

const [base, tag, feedUrl] = process.argv.slice(2);
if (!base || !tag || !feedUrl) {
  console.error("usage: node test/browser-walk.mjs <baseUrl> <tag> <feedUrl>");
  process.exit(2);
}
const outDir = `/data/workspace/lanes/53/walk/${tag}`;
fs.mkdirSync(outDir, { recursive: true });

const log = [];
let step = 0;
function record(action, observation, extra = {}) {
  step += 1;
  const entry = { step, action, observation, ...extra };
  log.push(entry);
  console.log(`\n== ${step}. ${action}`);
  console.log(observation);
  if (extra.assert !== undefined) console.log(`ASSERT ${extra.pass ? "ok" : "FAILED"}: ${extra.assert}`);
  return entry;
}
async function shot(page, name) {
  try {
    const file = path.join(outDir, `${String(step).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}
const rnd = Math.random().toString(36).slice(2, 8);
const body = () => page.evaluate(() => document.body.innerText);

function check(label, ok) {
  record(label, ok ? "passed" : "FAILED", { assert: label, pass: ok });
}

// Slot start times (ISO) offered on a booking page, read off the slot links
// so the check is on the data, not the rendered text.
async function slotStarts(pathAndQuery) {
  await goto(`${base}${pathAndQuery}`);
  return page.$$eval("a.slot, .slotlist a, .slot a", (as) => as.map((a) => {
    const m = a.href.match(/start=([^&"]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }).filter(Boolean));
}

// The notes the pages make about external calendars, verbatim.
async function noteTexts() {
  return page.$$eval(".note", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  env: { ...process.env, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH },
  // One renderer and site-per-process off: this machine is small, and a
  // renderer crash must not end the walk — navigation retries on a fresh page.
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
         "--renderer-process-limit=1", "--process-per-site"],
});
const context = await browser.createBrowserContext();
let page = await context.newPage();
page.setDefaultNavigationTimeout(30000);

async function freshPage() {
  try { await page.close(); } catch {}
  page = await context.newPage();
  await page.emulateTimezone("America/New_York");
  page.setDefaultNavigationTimeout(30000);
}
await page.emulateTimezone("America/New_York");

async function goto(url, opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", ...opts });
    } catch (e) {
      if (attempt === 3) throw e;
      record(`navigation to ${url} failed (attempt ${attempt})`, `${e.message.slice(0, 80)} — retrying on a fresh page`);
      await freshPage();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
async function clickNav(selector) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click(selector)]);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      record(`click on ${selector} failed (attempt ${attempt})`, `${e.message.slice(0, 80)} — retrying on a fresh page`);
      await freshPage();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

try {
  // ---------- logged out ----------
  await goto(`${base}/`);
  record("open the landing page logged out", `title: ${await page.title()}`);
  const cardItems = await page.$$eval(".note li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  record("read the what-is-checked card", JSON.stringify(cardItems, null, 2));
  await shot(page, "landing");

  // The demo booking page, the way a visitor arrives from the landing page.
  const demoHref = await page.$eval('a[href^="/b/"]', (a) => a.getAttribute("href")).catch(() => null);
  if (demoHref) {
    const demoSlug = demoHref.slice(3);
    await goto(`${base}/b/${demoSlug}?tz=America/New_York`);
    record("open the demo booking page from the landing page",
      `banner + notes: ${(await noteTexts()).join(" | ")}`);
    await shot(page, "demo-page");

    // A guest books a demo slot with the browser's own zone (America/New_York).
    const demoStarts = await slotStarts(`/b/${demoSlug}?tz=America/New_York`);
    const demoStart = demoStarts[0];
    record("list the demo's open slots", `${demoStarts.length} slots; first starts ${demoStart}`);
    await goto(`${base}/b/${demoSlug}/new?start=${encodeURIComponent(demoStart)}&tz=America/New_York`);
    const formCard = await page.$eval(".card", (el) => el.innerText.replace(/\s+/g, " "));
    record("open the booking form", `time card says: ${formCard}`);
    await shot(page, "demo-form");
    await page.type("#guest_name", "Walk Guest");
    await page.type("#guest_email", `walk-guest-${rnd}@example.com`);
    await clickNav("form button");
    const confirmedText = await body();
    record("submit the demo booking",
      `headline: ${confirmedText.match(/You're booked|Booking moved|Something went wrong/)?.[0] || "?"}; card: ${confirmedText.slice(confirmedText.indexOf("Booked for"), confirmedText.indexOf("Booked for") + 160)}`);
    await shot(page, "demo-confirmed");
    const demoIcsUrl = await page.$eval('a[href*=".ics"]', (a) => a.getAttribute("href"));
    const demoIcs = await page.evaluate(async (u) => await (await fetch(u)).text(), demoIcsUrl);
    const demoDesc = demoIcs.replace(/\r\n /g, "").match(/DESCRIPTION:([^\r\n]*)/)?.[1] || "";
    record("open the demo .ics", demoDesc.replace(/\\n/g, " | "));
    check("the demo .ics speaks the guest's zone (America/New_York)", /Your time: .+\(America\/New_York\)/.test(demoDesc));
  } else {
    record("the landing page offers no demo link", "(walked anyway)");
  }

  // ---------- logged in ----------
  await goto(`${base}/signup`);
  const preselectedZone = await page.$eval("#timezone", (el) => el.value);
  record("open sign-up", `the browser's zone the form preselected: ${preselectedZone}`);
  await page.type("#name", `Walk Organizer ${rnd}`);
  await page.type("#email", `walk-org-${rnd}@example.com`);
  await page.type("#password", "walk-test-password");
  await page.select("#timezone", "America/New_York");
  await clickNav("form button");
  const dashText = await body();
  const shareLink = dashText.match(/https?:\/\/\S+\/b\/[a-z0-9]+/)?.[0];
  record("sign up, land on the dashboard", `share link shown: ${shareLink}`);
  await shot(page, "dashboard-new");
  const emptyRow = dashText.match(/No bookings yet[^\n]*/)?.[0];
  record("read the empty-bookings row", emptyRow || "(no empty row)");
  record("read the dashboard's calendar note", (await noteTexts()).join(" | "));

  // Set the event type: every day 09:00-17:00 UTC, 30-minute slots.
  const editHref = await page.$eval('a[href^="/event-types/"]', (a) => a.getAttribute("href"));
  await goto(`${base}${editHref}`);
  await page.$eval("#event_name", (el) => (el.value = ""));
  await page.type("#event_name", "Walk call");
  await page.select("#timezone", "UTC");
  for (let dow = 1; dow <= 7; dow++) {
    await page.$eval(`#d${dow}_s`, (el) => (el.value = ""));
    await page.$eval(`#d${dow}_e`, (el) => (el.value = ""));
    await page.type(`#d${dow}_s`, "09:00");
    await page.type(`#d${dow}_e`, "17:00");
  }
  await clickNav("form button");
  record("save weekly hours (every day 09:00-17:00 UTC)", `back on: ${page.url()}`);

  // Guest view before any calendar is connected: the busy hour is offered.
  const slug = new URL(shareLink).pathname.slice(3);
  const before = await slotStarts(`/b/${slug}?tz=UTC&date=2026-11-02`);
  const busy = "2026-11-02T10:00:00.000Z";
  check("before connecting, the 10:00 UTC slot on Mon 2 Nov is offered", before.includes(busy));
  await shot(page, "booking-page-no-calendar");

  // Connect the calendar in the dashboard form.
  await goto(`${base}/dashboard`);
  await page.type("#cal_url", feedUrl);
  await clickNav("form[action$='/dashboard/calendar'] button");
  const afterConnect = await body();
  const connectLine = afterConnect.match(/Connected[^\n]*/)?.[0];
  record("connect the calendar", `${connectLine} | notes: ${(await noteTexts()).join(" | ")}`);
  await shot(page, "dashboard-connected");

  // Guest view after connecting: the busy hour is hidden, the note says so.
  const after = await slotStarts(`/b/${slug}?tz=UTC&date=2026-11-02`);
  // Slots that overlap the 10:00-11:00 UTC busy hour: starts 10:00 and 10:30.
  // (A 09:30 slot ends at 10:00 — back-to-back, not an overlap.)
  const hidden = [busy, "2026-11-02T10:30:00.000Z"].filter((s) => after.includes(s));
  check("after connecting, the slots overlapping the busy hour are hidden", hidden.length === 0);
  await goto(`${base}/b/${slug}?tz=UTC&date=2026-11-02`);
  record("read the booking page's calendar note with a calendar connected", (await noteTexts()).join(" | "));
  await shot(page, "booking-page-connected");

  // A direct POST to book the busy slot must be refused.
  const postResult = await page.evaluate(async (url, start) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ start, tz: "UTC", guest_name: "Sneaky", guest_email: "sneaky@example.com" }),
      redirect: "manual",
    });
    return res.status;
  }, `${base}/b/${slug}/book`, busy);
  check("a direct POST for the busy slot is refused with 409", postResult === 409);

  // A free slot still books end to end with the calendar connected.
  const freeStart = after.find((s) => s > busy);
  await goto(`${base}/b/${slug}/new?start=${encodeURIComponent(freeStart)}&tz=America/New_York`);
  await page.type("#guest_name", "Walk Guest 2");
  await page.type("#guest_email", `walk-guest2-${rnd}@example.com`);
  await clickNav("form button");
  const confirmed2 = await body();
  const id2 = page.url().match(/confirmed\/([0-9a-f]+)/)?.[1];
  record("book a free slot with the calendar connected",
    `headline: ${confirmed2.match(/You're booked|Booking moved/)?.[0]}; the confirmation note says: ${confirmed2.match(/Times the organizer's external calendar[^.]*/)?.[0] || "(see .ics)"}`);
  const ics2 = await page.evaluate(async (u) => await (await fetch(u)).text(), `/cal/${id2}.ics`);
  const desc2 = ics2.replace(/\r\n /g, "").match(/DESCRIPTION:([^\r\n]*)/)?.[1] || "";
  record("open that booking's .ics", desc2.replace(/\\n/g, " | "));
  check("the .ics again speaks the guest's zone", /Your time: .+\(America\/New_York\)/.test(desc2));
  check("the .ics says the external calendar was checked", /times were checked against the organizer's external calendar/.test(desc2));

  // Disconnect, and the honest note comes back.
  await goto(`${base}/dashboard`);
  await clickNav("form[action$='/dashboard/calendar/disconnect'] button");
  record("disconnect the calendar", (await noteTexts()).join(" | "));
  const afterDisconnect = await slotStarts(`/b/${slug}?tz=UTC&date=2026-11-02`);
  check("after disconnecting, the busy slot is offered again", afterDisconnect.includes(busy));

  // Delete the throwaway account; the walk leaves nothing behind.
  await goto(`${base}/dashboard/delete`);
  await page.type("#password", "walk-test-password");
  await clickNav("form[action$='/dashboard/delete'] button");
  record("delete the account", `now at: ${page.url()}`);
  await goto(`${base}/dashboard`);
  check("the deleted account cannot reach the dashboard", page.url().includes("/login"));
  await shot(page, "after-delete");
} finally {
  fs.writeFileSync(path.join(outDir, "walk.log"), JSON.stringify(log, null, 2));
  await browser.close();
}
console.log(`\nWalk complete: ${step} steps, screenshots in ${outDir}`);
