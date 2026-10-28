// Server-rendered HTML views. Plain functions, standard library only.
"use strict";

const time = require("./time");

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CALENDAR_NOTE =
  "We do not check external calendars. A slot can be taken even if your own calendar shows you busy — keep your own calendar handy.";

// How long ago a calendar check ran, in the few words a page can spare.
function agoLabel(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

// The honest note a public page shows about external calendars. It says what
// is checked, how fresh the check is, and what is not.
function calendarNote(cal, booked = false) {
  if (!cal || !cal.connected) return CALENDAR_NOTE;
  if (!cal.ok) {
    return booked
      ? "The organizer's external calendar was not readable at the moment you booked, so its busy times may not have been reflected."
      : "This page usually hides times the organizer's external calendar shows busy, but the calendar could not be checked just now — a shown time may have been taken after all.";
  }
  let text = booked
    ? "Times the organizer's external calendar shows busy were hidden when this booking was made"
    : "Times the organizer's external calendar shows busy are already hidden from this page";
  if (cal.checkedAt) text += ` (checked ${agoLabel(cal.checkedAt)})`;
  text += ".";
  if (cal.approximate) text += " Unusual repeat patterns in that calendar may not be reflected.";
  text += " The organizer's calendar can still change after you book.";
  return text;
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #1b2733; line-height: 1.5; }
  a { color: #0b62d6; }
  header { background: #10305c; color: #fff; padding: 0.7rem 1rem; display: flex;
            justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  header .brand { font-weight: 700; font-size: 1.05rem; color: #fff; text-decoration: none; }
  header .links a { color: #cfe2ff; margin-left: 0.9rem; font-size: 0.95rem; }
  main { max-width: 42rem; margin: 0 auto; padding: 1.2rem 1rem 3rem; }
  main.wide { max-width: 56rem; }
  h1 { font-size: 1.45rem; margin: 0.6rem 0 0.3rem; }
  h2 { font-size: 1.1rem; margin: 1.6rem 0 0.4rem; }
  .muted { color: #5b6b7b; font-size: 0.92rem; }
  .note { background: #fff8e1; border: 1px solid #e8d48a; border-radius: 8px;
          padding: 0.6rem 0.8rem; font-size: 0.9rem; margin: 0.8rem 0; }
  .card { background: #fff; border: 1px solid #dde3ea; border-radius: 10px; padding: 1rem 1.1rem; margin: 0.8rem 0; }
  label { display: block; font-size: 0.9rem; font-weight: 600; margin: 0.7rem 0 0.2rem; }
  input, select, textarea { width: 100%; padding: 0.5rem 0.6rem; font: inherit;
          border: 1px solid #b9c4cf; border-radius: 7px; background: #fff; color: inherit; }
  input[type=checkbox] { width: auto; }
  button { font: inherit; background: #0b62d6; border: 0; color: #fff; border-radius: 7px;
           padding: 0.5rem 0.9rem; cursor: pointer; margin-top: 0.8rem; }
  button.secondary { background: #44546a; }
  button.small { padding: 0.3rem 0.7rem; font-size: 0.88rem; margin-top: 0; }
  button.danger { background: #b3372e; }
  button.linklike { background: none; border: 0; color: #0b62d6; text-decoration: underline;
                    padding: 0; margin-top: 0; cursor: pointer; font-size: inherit; }
  .inline { display: inline; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid #e4e9ef; vertical-align: top; }
  .slotlist { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .slot { display: inline-block; background: #fff; border: 1px solid #b9c4cf; border-radius: 8px;
          padding: 0.45rem 0.7rem; text-decoration: none; color: inherit; text-align: center; }
  .slot .t { font-weight: 700; display: block; }
  .slot .alt { color: #5b6b7b; font-size: 0.78rem; display: block; }
  .days { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.8rem 0; }
  .days a { border: 1px solid #b9c4cf; border-radius: 7px; padding: 0.35rem 0.6rem; text-decoration: none;
            color: inherit; font-size: 0.9rem; background: #fff; }
  .days a.active { background: #10305c; color: #fff; border-color: #10305c; }
  .days a.none { color: #98a5b1; }
  .flash { background: #e7f3e8; border: 1px solid #9fd0a5; border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.8rem 0; }
  .error { background: #fbeaea; border: 1px solid #e39b9b; border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.8rem 0; }
  .copy { font-family: ui-monospace, monospace; font-size: 0.85rem; background: #eef1f5;
          border-radius: 6px; padding: 0.2rem 0.4rem; word-break: break-all; }
  .row { display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 9rem; }
  .zonebar { display: flex; gap: 0.6rem; align-items: end; margin: 0.8rem 0; flex-wrap: wrap; }
  .zonebar > div { flex: 0 1 22rem; }
  footer { text-align: center; color: #7c8a97; font-size: 0.8rem; padding: 1rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #161b21; color: #dfe6ee; }
    .card, .slot, .days a, input, select, textarea { background: #1f2731; border-color: #3a4653; }
    .copy { background: #26303b; }
    .note { background: #3a3526; }
  }
`;

function layout(title, body, opts = {}) {
  const links = opts.links || "";
  // Paid organizers get their public booking pages without our branding; the
  // brand stays everywhere else (dashboard, home, sign-up).
  const branded = opts.branding !== false;
  const brand = branded
    ? `<a class="brand" href="/">OpenCalendly</a>`
    : `<span class="brand">${esc(opts.headerText || "")}</span>`;
  const titleText = branded ? `${esc(title)} — OpenCalendly` : esc(title);
  const footer = branded ? `<footer>OpenCalendly — simple booking links.</footer>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleText}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  ${brand}
  <nav class="links">${links}</nav>
</header>
<main class="${opts.wide ? "wide" : ""}">
${body}
</main>
${footer}
</body>
</html>`;
}

// The banner the live-demo booking page shows. The demo organizer is flagged
// in its stored record, so the pages say it plainly without a special route.
function demoBanner(organizer) {
  if (!organizer.demo) return "";
  return `<div class="note"><strong>This is the live demo.</strong> Book anything — you will see exactly
    what a client of yours sees: a confirmation page, a calendar file, and cancel and
    reschedule links. No real person receives these bookings.</div>`;
}

// The public landing page. The demo link is passed in only when a demo
// organizer actually exists, so the page never advertises a dead link.
function homePage({ demoSlug = null } = {}) {
  const demo = demoSlug
    ? `<div class="card">
    <h2>Try it now — a live demo</h2>
    <p>This is a real booking page running on this site, not screenshots. Pick a slot and
       book it the way a client of yours would: you get a confirmation page, a calendar
       file, and cancel and reschedule links that actually work.</p>
    <p><a href="/b/${esc(demoSlug)}">Open the live demo booking page →</a></p>
  </div>`
    : "";
  const body = `
  <h1>A dependable booking link</h1>
  <p>Set your weekly availability once, share one link, and let clients pick a time —
     no account needed for them, and no double bookings for you.</p>
  <p><a href="/signup">Create a free account</a>${demoSlug ? ` · <a href="/b/${esc(demoSlug)}">Try the live demo first</a>` : ""}</p>
  ${demo}
  <div class="card">
    <h2>How it works</h2>
    <ol>
      <li>Create an account and set your weekly hours in your own time zone.</li>
      <li>Share your booking link — on your website, in your email signature, anywhere.</li>
      <li>Clients pick a slot and book with just a name and email. No account for them,
          and two people can never grab the same slot.</li>
    </ol>
    <p class="muted">Free: one event type and unlimited bookings. $8/month: up to three
       event types and no OpenCalendly branding on your booking page.</p>
  </div>
  <div class="note">
    <strong>What this checks — and what it does not.</strong>
    <ul>
      <li><strong>Checked and built:</strong> time zones shown side by side on every slot;
          double-booking protection (even when two guests pick the same slot at the same
          moment); confirmation, cancellation and rescheduling emails; an .ics calendar
          file per booking; cancellation and rescheduling straight from the confirmation;
          export and deletion of an organizer's data; read-only checking of one external
          calendar, which hides the times it shows busy and says when it last looked.</li>
      <li><strong>Not yet:</strong> real card payments — the $8 tier currently runs on
          clearly labelled test-USDC payments on a public testnet, which grant access but
          are not real money; team routing and sales integrations; write access to your
          calendar. An external calendar is only checked when connected, and it can still
          change right after a booking is made.</li>
      <li><strong>Emails:</strong> with no mail server configured, emails queue in the
          organizer's dashboard instead of being sent, and every page says so.</li>
    </ul>
  </div>
  <p><a href="/signup">Create a free account</a>${demoSlug ? ` · <a href="/b/${esc(demoSlug)}">Try the live demo</a>` : ""} · <a href="/login">Sign in</a></p>`;
  return layout("Simple booking links", body);
}

function signupPage(values = {}, error = null) {
  const zones = commonZones();
  const body = `
  <h1>Create your organizer account</h1>
  <p class="muted">Private: only you sign in with your password. Your booking page is shared with whoever you send the link to.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/signup">
    <div class="row">
      <div><label for="name">Your name</label><input id="name" name="name" required maxlength="80" value="${esc(values.name || "")}"></div>
      <div><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120" value="${esc(values.email || "")}"></div>
    </div>
    <div class="row">
      <div><label for="password">Password (at least 8 characters)</label><input id="password" name="password" type="password" required minlength="8" maxlength="200"></div>
      <div><label for="timezone">Your time zone</label><select id="timezone" name="timezone">${zones}</select></div>
    </div>
    <button>Create account</button>
  </form>
  <script>
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      var sel = document.getElementById("timezone");
      if ([...sel.options].some(function (o) { return o.value === zone; })) sel.value = zone;
    } catch (e) {}
  </script>
  <p class="muted">Already have an account? <a href="/login">Sign in</a>.</p>`;
  return layout("Sign up", body);
}

function loginPage(error = null, email = "") {
  const body = `
  <h1>Sign in</h1>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/login">
    <label for="email">Email</label><input id="email" name="email" type="email" required maxlength="120" value="${esc(email)}">
    <label for="password">Password</label><input id="password" name="password" type="password" required maxlength="200">
    <button>Sign in</button>
  </form>
  <p class="muted">New here? <a href="/signup">Create an account</a>.</p>`;
  return layout("Sign in", body);
}

const DOW_LABEL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// One window per weekday. Empty start/end means closed.
function availabilityRows(availability) {
  let rows = "";
  for (let dow = 1; dow <= 7; dow++) {
    const window_ = (availability && availability[String(dow)] && availability[String(dow)][0]) || null;
    const s = window_ ? window_.s : "";
    const e = window_ ? window_.e : "";
    rows += `
    <div class="row">
      <div style="flex:0 0 7rem"><label for="d${dow}_s">${DOW_LABEL[dow - 1]}</label></div>
      <div><label for="d${dow}_s" class="muted">from</label><input id="d${dow}_s" name="d${dow}_s" placeholder="09:00" value="${esc(s)}" inputmode="numeric"></div>
      <div><label for="d${dow}_e" class="muted">to</label><input id="d${dow}_e" name="d${dow}_e" placeholder="17:00" value="${esc(e)}" inputmode="numeric"></div>
    </div>`;
  }
  return rows;
}

function durationOptions(selected) {
  return [15, 20, 30, 45, 60]
    .map((m) => `<option value="${m}"${m === selected ? " selected" : ""}>${m} minutes</option>`)
    .join("");
}

function dashboardPage({ organizer, baseUrl, bookings, outbox, mailConfigured, plan, cal = { connected: false }, flash = null, error = null }) {
  const upcoming = bookings
    .filter((b) => b.endMs > Date.now() && b.status !== "cancelled")
    .sort((a, b) => a.startMs - b.startMs);
  const bookingRows = upcoming.length
    ? upcoming
        .map(
          (b) => `<tr>
        <td>${esc(time.describeInZone(b.startMs, organizer.timezone))}</td>
        <td>${esc(b.guestName)}<br><span class="muted">${esc(b.guestEmail)}</span>${b.guestNote ? `<br><span class="muted">“${esc(b.guestNote)}”</span>` : ""}</td>
        <td>
          <a href="/cal/${esc(b.id)}.ics">calendar file</a>
          <form method="post" action="/dashboard/cancel/${esc(b.id)}" class="inline" onsubmit="return confirm('Cancel this booking and email the guest?')">
            <button class="linklike" type="submit">cancel</button>
          </form>
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No bookings yet. Share your link below.</td></tr>`;
  const queued = outbox.filter((e) => e.status === "queued").length;
  const mailIntro = mailConfigured
    ? `A mail server is connected: emails send automatically with each booking.`
    : `No mail server is connected yet, so confirmation emails are queued below instead of being sent. Your bookings are confirmed regardless.`;
  const mailPanel = outbox.length
    ? `<p class="muted">${esc(mailIntro)}${!mailConfigured && queued ? ` ${queued} email(s) queued.` : ""}</p>
       <table><tr><th>To</th><th>Subject</th><th>Status</th></tr>
       ${outbox.slice(-8).reverse().map((e) => `<tr><td>${esc(e.to)}</td><td>${esc(e.subject)}</td><td>${esc(e.status)}</td></tr>`).join("")}
       </table>`
    : `<p class="muted">${esc(mailIntro)} No emails yet.</p>`;

  const body = `
  <h1>Your dashboard</h1>
  ${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <h2>Share your booking link</h2>
  <p><span class="copy">${esc(baseUrl)}/b/${esc(organizer.slug)}</span></p>
  <p class="muted">Guests see your availability in their own time zone, next to yours. ${esc(calendarNote(cal))}</p>

  <h2>Event types</h2>
  <table>
    <tr><th>Name</th><th>Slot length</th><th></th></tr>
    ${(organizer.eventTypes || [])
      .map((t, i) => {
        const paused = !plan.paid && i >= plan.limit;
        return `<tr>
      <td>${esc(t.name)}${paused ? ` <span class="muted">(paused — bookable again after a payment)</span>` : ""}</td>
      <td>${esc(t.durationMinutes)} min</td>
      <td><a href="/event-types/${esc(t.id)}">Edit hours</a>${organizer.eventTypes.length > 1 ? ` &middot; <form method="post" action="/event-types/${esc(t.id)}/delete" style="display:inline"><button class="small secondary" type="submit">Delete</button></form>` : ""}</td>
    </tr>`;
      })
      .join("")}
  </table>
  <p class="muted">${(organizer.eventTypes || []).length} of ${plan.limit} event type${plan.limit === 1 ? "" : "s"} bookable on your ${plan.paid ? "paid" : "free"} plan.</p>
  ${!plan.paid && (organizer.eventTypes || []).length > plan.limit
    ? `<p class="muted">${(organizer.eventTypes || []).length - plan.limit} extra event type${(organizer.eventTypes || []).length - plan.limit === 1 ? " is" : "s are"} paused: guests can no longer book ${((organizer.eventTypes || []).length - plan.limit) === 1 ? "it" : "them"} until a payment is verified again. Nothing was deleted — your settings and existing bookings stay.</p>`
    : ""}
  ${organizer.eventTypes.length < plan.limit
    ? `<p><a href="/event-types/new">Add an event type</a></p>`
    : `<p class="muted">That is your plan's limit. <a href="/upgrade">Upgrade</a> for up to three event types and no branding on your booking page.</p>`}

  <h2>Your plan</h2>
  ${plan.paid
    ? `<p>Paid — test access until <strong>${esc(time.describeInZone(plan.paidUntil, "UTC"))} (UTC)</strong>. <span class="muted">Granted by test payments; test payments are not revenue and this is not a real subscription.</span> <a href="/upgrade">Extend with another test payment</a>.</p>`
    : `<p class="muted">Free plan: one event type, unlimited bookings, our branding on your booking page. <a href="/upgrade">Upgrade for $8/month</a> — up to three event types and no branding. Payments there are test payments: test-USDC on a public testnet, no real money changes hands.</p>`}
  
  <table>
    <tr><th>When (your time zone)</th><th>Guest</th><th></th></tr>
    ${bookingRows}
  </table>

  <h2>Email</h2>
  ${mailPanel}

  <h2>External calendar (read-only)</h2>
  ${
    !cal.connected
      ? `<p class="muted">Connect one external calendar and your booking page will hide the times it shows busy. Without one, guests can book times your own calendar already holds.</p>
  <form method="post" action="/dashboard/calendar">
    <label for="cal_url">Your calendar's secret iCal address</label>
    <input id="cal_url" name="url" type="url" required maxlength="2000" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">
    <button>Connect calendar</button>
  </form>
  <p class="muted">Where to find it: Google Calendar → Settings → your calendar → “Secret address in iCal format” → copy. We read that feed, never write to it, and never show the address again.</p>`
      : `<p>Connected${cal.name ? `: <strong>${esc(cal.name)}</strong>` : ""} — <span class="copy">${esc(cal.maskedUrl)}</span></p>
  <p class="muted">${
    cal.ok
      ? `Busy times from this calendar are hidden from your booking page${cal.checkedAt ? `; last checked ${esc(agoLabel(cal.checkedAt))}` : ""}.${cal.approximate ? " Unusual repeat patterns in that calendar may not be reflected." : ""}`
      : `The last check failed: ${esc(cal.error || "unknown error")}. Your booking page is still up and shows manual availability; the next check retries.`
  }</p>
  <form method="post" action="/dashboard/calendar/disconnect"><button class="secondary">Disconnect calendar</button></form>`
  }

  <h2>Your data</h2>
  <p><a href="/dashboard/export">Download everything we hold about you (JSON)</a></p>
  <p class="muted"><a href="/dashboard/delete">Delete my account</a> — this permanently removes your event, availability, bookings and email record. Guests whose bookings existed keep a bare "cancelled" notice with no personal data in it.</p>`;
  return layout("Dashboard", body, {
    wide: true,
    links: `<a href="/logout" style="color:#cfe2ff">Sign out</a>`,
  });
}

function commonZones() {
  const common = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Africa/Lagos", "Africa/Johannesburg",
    "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
  let all = common;
  try {
    all = common.concat(Intl.supportedValuesOf("timeZone").filter((z) => !common.includes(z)));
  } catch {}
  return all.map((z) => `<option value="${esc(z)}">${esc(z)}</option>`).join("");
}

function zoneOptions(selected) {
  let zones;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = ["UTC"];
  }
  if (!zones.includes("UTC")) zones.push("UTC");
  if (!zones.includes(selected)) zones.push(selected);
  return zones
    .map((z) => `<option value="${esc(z)}"${z === selected ? " selected" : ""}>${esc(z)}</option>`)
    .join("");
}

// Public booking page: day tabs + slot list. Times in the guest's chosen zone,
// with the organizer's zone beside each slot. `event` is the event type being
// booked; `paid` removes our branding (the paid tier's other benefit).
function bookingPage({ organizer, event, baseUrl, days, selectedDate, guestZone, paid = false, cal = null, error = null }) {
  const eventType = event || (organizer.eventTypes || [])[0] || organizer.event;
  const organizerLabel = `${time.offsetLabel(organizer.timezone, Date.now())}`;
  // Carry the chosen event type through the page's own links when the
  // organizer has more than one.
  const eQ = (organizer.eventTypes || []).length > 1 ? `&e=${encodeURIComponent(eventType.id)}` : "";
  const dayTabs = days
    .map(({ date, slots }) => {
      const label = date.slice(5).replace("-", "/");
      const cls = date === selectedDate ? "active" : slots.length ? "" : "none";
      return `<a class="${cls}" href="?tz=${encodeURIComponent(guestZone)}${eQ}&amp;date=${date}">${esc(label)} (${slots.length})</a>`;
    })
    .join("");
  const sel = days.find((d) => d.date === selectedDate);
  const slotsHtml = sel && sel.slots.length
    ? `<div class="slotlist">` +
      sel.slots
        .map((s) => {
          const t = time.zoneParts(guestZone, s.startMs);
          const tEnd = time.zoneParts(guestZone, s.endMs);
          const o = time.zoneParts(organizer.timezone, s.startMs);
          const oEnd = time.zoneParts(organizer.timezone, s.endMs);
          const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
          return `<a class="slot" href="/b/${esc(organizer.slug)}/new?start=${encodeURIComponent(new Date(s.startMs).toISOString())}&amp;tz=${encodeURIComponent(guestZone)}${eQ}">
            <span class="t">${hm(t)} – ${hm(tEnd)}</span>
            <span class="alt">${hm(o)} – ${hm(oEnd)} in ${esc(organizer.timezone)} ${esc(organizerLabel)}</span>
          </a>`;
        })
        .join("") +
      `</div>`
    : `<p class="muted">No open slots on this day. Pick another day above, or check back later.</p>`;

  const body = `
  <h1>${esc(eventType.name)}</h1>
  <p class="muted">Hosted by ${esc(organizer.name)} · ${eventType.durationMinutes} minutes</p>
  ${demoBanner(organizer)}
  <form method="get" action="/b/${esc(organizer.slug)}" class="zonebar">
    <input type="hidden" name="e" value="${esc(eventType.id)}">
    <div><label for="tz">Show times in your time zone</label><select id="tz" name="tz">${zoneOptions(guestZone)}</select></div>
    <button class="small secondary">Update</button>
  </form>
  <p class="muted">Organizer's zone: <strong>${esc(organizer.timezone)} ${esc(organizerLabel)}</strong> — shown beside every slot.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <div class="days">${dayTabs}</div>
  ${slotsHtml}
  <div class="note">${esc(calendarNote(cal))}</div>`;
  return layout(`Book: ${eventType.name}`, body, {
    links: `<a href="/login">Organizer sign in</a>`,
    branding: !paid,
    headerText: organizer.name,
  });
}

// Guest details form for the chosen slot.
function bookingFormPage({ organizer, event, startMs, guestZone, values = {}, paid = false, cal = null, error = null }) {
  const eventType = event || (organizer.eventTypes || [])[0] || organizer.event;
  const g = time.zoneParts(guestZone, startMs);
  const o = time.zoneParts(organizer.timezone, startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const body = `
  <h1>${esc(eventType.name)}</h1>
  <p>With ${esc(organizer.name)}</p>
  ${demoBanner(organizer)}
  <div class="card">
    <strong>${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, startMs + eventType.durationMinutes * 60000)))}</strong>
    <span class="muted"> — your time (${esc(guestZone)})</span><br>
    <span class="muted">${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, startMs + eventType.durationMinutes * 60000)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/b/${esc(organizer.slug)}/book">
    <input type="hidden" name="start" value="${esc(new Date(startMs).toISOString())}">
    <input type="hidden" name="tz" value="${esc(guestZone)}">
    <input type="hidden" name="e" value="${esc(eventType.id)}">
    <label for="guest_name">Your name</label><input id="guest_name" name="guest_name" required maxlength="100" value="${esc(values.guest_name || "")}">
    <label for="guest_email">Your email</label><input id="guest_email" name="guest_email" type="email" required maxlength="120" value="${esc(values.guest_email || "")}">
    <label for="guest_note">Anything to add? (optional)</label><textarea id="guest_note" name="guest_note" maxlength="500" rows="3">${esc(values.guest_note || "")}</textarea>
    <button>Confirm booking</button>
  </form>
  <div class="note">${esc(calendarNote(cal))}</div>
  <p><a href="/b/${esc(organizer.slug)}?tz=${encodeURIComponent(guestZone)}&e=${encodeURIComponent(eventType.id)}">← Pick a different time</a></p>`;
  return layout("Confirm your booking", body, { branding: !paid, headerText: organizer.name });
}

function confirmedPage({ organizer, event, booking, baseUrl, guestZone, emailStatus, paid = false, cal = null, rescheduled = false }) {
  // The booking's own snapshot wins; a missing type never becomes a different
  // type — the page just says "Booking" instead of an event name.
  const eventType = event || (booking.eventType && booking.eventType.name ? booking.eventType : null);
  const eventLabel = eventType ? eventType.name : "Booking";
  const g = time.zoneParts(guestZone, booking.startMs);
  const o = time.zoneParts(organizer.timezone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const cancelled = booking.status === "cancelled";
  const emailLine =
    emailStatus === "sent"
      ? `<p>A confirmation email is on its way to <strong>${esc(booking.guestEmail)}</strong>.</p>`
      : `<p class="muted">The confirmation email to <strong>${esc(booking.guestEmail)}</strong> is queued — the organizer has not connected a mail server yet. Your booking is confirmed regardless; save the calendar file below.</p>`;
  const body = `
  <h1>${cancelled ? "This booking was cancelled" : rescheduled ? "Booking moved ✓" : "You're booked ✓"}</h1>
  ${rescheduled && !cancelled ? `<div class="flash">Your booking was moved. Both time zones below show the new time.</div>` : ""}
  <div class="card">
    <strong>${esc(eventLabel)}</strong> with ${esc(organizer.name)}<br>
    Booked for <strong>${esc(booking.guestName)}</strong><br>
    <span class="muted">${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))} — your time (${esc(guestZone)})</span><br>
    <span class="muted">${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, booking.endMs)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${emailLine}
  <p><a href="/cal/${esc(booking.id)}.ics">Add to your calendar (.ics)</a></p>
  ${
    cancelled
      ? ""
      : `<p class="actions"><a href="/b/${esc(organizer.slug)}/reschedule/${esc(booking.id)}?tz=${encodeURIComponent(guestZone)}">Reschedule</a> · <a href="/b/${esc(organizer.slug)}/cancel/${esc(booking.id)}?tz=${encodeURIComponent(guestZone)}">Cancel</a></p>`
  }
  <div class="note">${esc(calendarNote(cal, true))}</div>`;
  return layout("Booking confirmed", body, { branding: !paid, headerText: organizer.name });
}

// When an organizer has several event types, the public page lists them first.
// `types` is the list the route passes — the types bookable right now — and
// the branding follows the organizer's current entitlement exactly like the
// other public pages, so it does not outlive the paid access it came with.
function eventPickerPage({ organizer, types, baseUrl, guestZone, paid = false, cal = null }) {
  const list = (types || [])
    .map(
      (t) => `<a class="slot" href="/b/${esc(organizer.slug)}?tz=${encodeURIComponent(guestZone)}&e=${encodeURIComponent(t.id)}">
      <span class="t">${esc(t.name)}</span>
      <span class="alt">${esc(t.durationMinutes)} minutes</span>
    </a>`
    )
    .join("");
  const body = `
  <h1>Book with ${esc(organizer.name)}</h1>
  <p class="muted">Pick an event type.</p>
  <div class="slotlist">${list}</div>
  <div class="note">${esc(calendarNote(cal))}</div>`;
  return layout(`Book with ${organizer.name}`, body, {
    links: `<a href="/login">Organizer sign in</a>`,
    branding: !paid,
    headerText: organizer.name,
  });
}

// Shared create/edit form for an event type.
function eventTypeFormPage({ organizer, eventType = null, values = {}, error = null }) {
  const editing = Boolean(eventType);
  const defaultAvailability = { 1: [{ s: "09:00", e: "17:00" }], 2: [{ s: "09:00", e: "17:00" }], 3: [{ s: "09:00", e: "17:00" }], 4: [{ s: "09:00", e: "17:00" }], 5: [{ s: "09:00", e: "17:00" }] };
  const v = {
    name: values.name !== undefined ? values.name : (eventType ? eventType.name : ""),
    duration: values.duration !== undefined ? values.duration : (eventType ? eventType.durationMinutes : 30),
    timezone: values.timezone !== undefined ? values.timezone : organizer.timezone,
    availability: values.availability !== undefined
      ? values.availability
      : (eventType ? eventType.availability : defaultAvailability),
  };
  const action = editing ? `/event-types/${esc(eventType.id)}` : "/event-types";
  const body = `
  <h1>${editing ? `Edit “${esc(eventType.name)}”` : "Add an event type"}</h1>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="${action}">
    <label for="event_name">Event name</label><input id="event_name" name="event_name" maxlength="60" required value="${esc(v.name)}">
    <div class="row">
      <div><label for="duration">Slot duration</label><select id="duration" name="duration">${durationOptions(Number(v.duration))}</select></div>
      <div><label for="timezone">Your time zone</label><select id="timezone" name="timezone">${zoneOptions(v.timezone)}</select></div>
    </div>
    <h2>Weekly hours</h2>
    <p class="muted">One window per day, in <strong>${esc(v.timezone)}</strong>. Leave both fields empty to close a day.</p>
    ${availabilityRows(v.availability)}
    <button>${editing ? "Save changes" : "Add event type"}</button>
  </form>
  <p><a href="/dashboard">← Back to the dashboard</a></p>`;
  return layout(editing ? "Edit event type" : "Add event type", body);
}

// The test-payment flow, step 1 of 2. Everything here says TEST, because these
// payments are test-USDC on a public testnet: no real money, no real revenue,
// 30 days of paid access per verified payment.
function upgradePage({ pay, plan, values = {}, error = null }) {
  const status = plan.paid
    ? `<div class="flash">Your plan is paid (test access until ${esc(time.describeInZone(plan.paidUntil, "UTC"))} UTC). Another verified test payment extends it by another 30 days.</div>`
    : `<p class="muted">Your plan: free — one event type, our branding on your booking page. A verified payment grants 30 days of paid access: up to three event types, no branding.</p>`;
  const inner = !pay.enabled
    ? `<p>Test payments are not configured on this deployment yet, so there is nothing to pay and nothing is pretended. The paid tier's limits and labelling are all in place otherwise.</p>`
    : `
  <p>The payment is bound to your account by the wallet you send it from. Declare the test wallet you will pay with; the server then accepts only a transfer of exactly <strong>${esc(pay.fmtAmount(pay.priceMinor))} test-USDC</strong> from that address.</p>
  <form method="post" action="/upgrade">
    <label for="sender">Your test wallet address (the sender)</label>
    <input id="sender" name="sender" required maxlength="50" placeholder="0x…" value="${esc(values.sender || "")}">
    <button>Get payment instructions</button>
  </form>`;
  const body = `
  <h1>Upgrade your plan</h1>
  <div class="note"><strong>Test payment.</strong> This is a test of the payment flow: test-USDC on a testnet, no real money. It grants 30 days of test access per payment and is not revenue.</div>
  ${status}
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  ${inner}
  <p class="muted">Nothing here is real revenue: these are test payments, clearly labelled, and they never count toward any demand target. Real card payments need an approved payment route, which does not exist yet.</p>`;
  return layout("Upgrade", body);
}

// Step 2 of 2: the instructions for one payment intent, and the form that
// submits the transaction hash. The intent belongs to one account and one
// sending address, so a transfer can only ever grant access to the account
// that declared it.
function paymentInstructionsPage({ pay, plan, intent, values = {}, error = null }) {
  const expired = intent.consumedAt || Number(intent.expiresAt) < Date.now();
  const instructions = expired
    ? `<p>This payment instruction has expired${intent.consumedAt ? " (it was already used)" : ""}. <a href="/upgrade">Start again</a>.</p>`
    : `
  <p><strong>Send exactly</strong></p>
  <p style="font-size:1.3rem"><strong>${esc(pay.fmtAmount(intent.amountMinor))} test-USDC</strong></p>
  <table>
    <tr><th>Network</th><td>${esc(pay.chainName)} — a public testnet. Test-USDC has no value.</td></tr>
    <tr><th>Token</th><td>USDC (test) <span class="copy">${esc(pay.token)}</span></td></tr>
    <tr><th>Send to</th><td><span class="copy">${esc(pay.recipient)}</span></td></tr>
    <tr><th>Send from</th><td><span class="copy">${esc(intent.senderAddress)}</span></td></tr>
  </table>
  <p class="muted">The amount is exactly the same for every payment — what binds the transfer to your account is that it comes from the address you declared. A transfer from any other address, or one someone else makes, cannot be redeemed here.</p>
  <p>After the transfer is confirmed on-chain (a few seconds), paste the transaction hash here. The server checks the chain itself — it does not take your word for the payment.</p>
  <form method="post" action="/upgrade/${esc(intent.id)}">
    <label for="tx">Transaction hash</label><input id="tx" name="tx" required maxlength="80" placeholder="0x…" value="${esc(values.tx || "")}">
    <button>Verify payment and grant 30 days</button>
  </form>
  <p class="muted">This instruction expires ${esc(time.describeInZone(intent.expiresAt, "UTC"))} UTC and grants once.</p>`;
  const body = `
  <h1>Your test payment</h1>
  <div class="note"><strong>Test payment.</strong> Test-USDC on a testnet, no real money. 30 days of test access per verified payment; not revenue.</div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  ${instructions}
  <p><a href="/dashboard">← Back to the dashboard</a></p>`;
  return layout("Test payment instructions", body);
}

// "Are you sure?" page for cancelling a booking. The confirmation link in the
// email and the confirmed page both land here; cancelling frees the slot.
function cancelConfirmPage({ organizer, booking, baseUrl, guestZone, error = null }) {
  const g = time.zoneParts(guestZone, booking.startMs);
  const o = time.zoneParts(organizer.timezone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  // The booked event's own name — from the booking's snapshot if the type has
  // since been renamed or deleted — never whichever type is first now.
  const eventLabel = booking.eventType && booking.eventType.name ? booking.eventType.name : "Booking";
  const body = `
  <h1>Cancel this booking?</h1>
  <p class="muted">${esc(eventLabel)} with ${esc(organizer.name)}</p>
  <div class="card">
    <strong>${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))}</strong>
    <span class="muted"> — your time (${esc(guestZone)})</span><br>
    <span class="muted">${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, booking.endMs)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/b/${esc(organizer.slug)}/cancel/${esc(booking.id)}">
    <input type="hidden" name="tz" value="${esc(guestZone)}">
    <p class="muted">Cancelling frees the slot for other guests and notifies the organizer by email. You can book again any time.</p>
    <button>Yes, cancel my booking</button>
  </form>
  <p><a href="/b/${esc(organizer.slug)}/confirmed/${esc(booking.id)}?tz=${encodeURIComponent(guestZone)}">← Keep the booking</a></p>`;
  return layout("Cancel booking", body);
}

// organizer is null when the organizer's account was deleted: the booking is
// an anonymous stub then, and its page still answers — honestly, without data.
function cancelledPage({ organizer, booking, baseUrl, guestZone }) {
  const anonymous = !booking.guestEmail; // organizer deleted their account; data is gone
  const g = time.zoneParts(guestZone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const eventLabel = booking.eventType && booking.eventType.name ? booking.eventType.name : "Booking";
  const body = `
  <h1>Booking cancelled</h1>
  <div class="card">
    ${organizer ? `<strong>${esc(eventLabel)}</strong> with ${esc(organizer.name)} — cancelled.<br>` : ""}
    ${anonymous
      ? `<span class="muted">The organizer's account was deleted; the booking details are gone with it.</span>`
      : `<span class="muted">The cancelled slot was ${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))} (${esc(guestZone)})</span>`}
  </div>
  ${organizer ? `<p>The time is free again. <a href="/b/${esc(organizer.slug)}?tz=${encodeURIComponent(guestZone)}">Book another time</a>.</p>` : ""}`;
  return layout("Booking cancelled", body);
}

// Reschedule page: same day tabs and slot list as the booking page, but the
// chosen slot moves an existing booking instead of creating a new one. The
// guest's current time is shown for comparison.
function reschedulePage({ organizer, event, booking, baseUrl, days, selectedDate, guestZone, cal = null, error = null }) {
  const g = time.zoneParts(guestZone, booking.startMs);
  const o = time.zoneParts(organizer.timezone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const organizerLabel = time.offsetLabel(organizer.timezone, Date.now());
  // The event the booking belongs to: its snapshot keeps the page honest when
  // the type was renamed or removed after the booking was made.
  const eventType = event || (booking.eventType && booking.eventType.name ? booking.eventType : null);
  const eventLabel = eventType ? eventType.name : "Booking";
  const eventMinutes = eventType ? eventType.durationMinutes : Math.round((booking.endMs - booking.startMs) / 60000);
  const dayTabs = days
    .map(({ date, slots }) => {
      const label = date.slice(5).replace("-", "/");
      const cls = date === selectedDate ? "active" : slots.length ? "" : "none";
      return `<a class="${cls}" href="?tz=${encodeURIComponent(guestZone)}&amp;date=${date}">${esc(label)} (${slots.length})</a>`;
    })
    .join("");
  const sel = days.find((d) => d.date === selectedDate);
  const slotsHtml = sel && sel.slots.length
    ? `<div class="slotlist">` +
      sel.slots
        .map((s) => {
          const t = time.zoneParts(guestZone, s.startMs);
          const tEnd = time.zoneParts(guestZone, s.endMs);
          const ob = time.zoneParts(organizer.timezone, s.startMs);
          const obEnd = time.zoneParts(organizer.timezone, s.endMs);
          return `<form method="post" action="/b/${esc(organizer.slug)}/reschedule/${esc(booking.id)}">
            <input type="hidden" name="start" value="${esc(new Date(s.startMs).toISOString())}">
            <input type="hidden" name="tz" value="${esc(guestZone)}">
            <button class="small slotbtn">
              <span class="t">${esc(hm(t))} – ${esc(hm(tEnd))}</span>
              <span class="alt">${esc(hm(ob))} – ${esc(hm(obEnd))} in ${esc(organizer.timezone)} ${esc(organizerLabel)}</span>
            </button>
          </form>`;
        })
        .join("") +
      `</div>`
    : `<p class="muted">No open slots on this day. Pick another day above, or check back later.</p>`;

  const body = `
  <h1>Move your booking</h1>
  <p class="muted">${esc(eventLabel)} with ${esc(organizer.name)} · ${esc(eventMinutes)} minutes</p>
  <div class="card">
    <span class="muted">Currently booked:</span>
    <strong>${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))}</strong>
    <span class="muted"> — your time (${esc(guestZone)})<br>
    ${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, booking.endMs)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="get" action="/b/${esc(organizer.slug)}/reschedule/${esc(booking.id)}" class="zonebar">
    <div><label for="tz">Show times in your time zone</label><select id="tz" name="tz">${zoneOptions(guestZone)}</select></div>
    <button class="small secondary">Update</button>
  </form>
  <p class="muted">Organizer's zone: <strong>${esc(organizer.timezone)} ${esc(organizerLabel)}</strong> — shown beside every slot.</p>
  <div class="days">${dayTabs}</div>
  ${slotsHtml}
  <p><a href="/b/${esc(organizer.slug)}/confirmed/${esc(booking.id)}?tz=${encodeURIComponent(guestZone)}">← Keep the current time</a></p>
  <div class="note">${esc(calendarNote(cal))}</div>`;
  return layout("Reschedule booking", body);
}

// Organizer data control: account deletion. Password-confirmed on the server.
function deleteAccountPage({ organizer, error = null }) {
  const body = `
  <h1>Delete your account</h1>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <div class="card">
    <p>This permanently deletes the account for <strong>${esc(organizer.name)}</strong> (${esc(organizer.email)}): the booking page <span class="copy">/b/${esc(organizer.slug)}</span>, all bookings, and the email record.</p>
    <p class="muted">Guest bookings become anonymous stubs so old links stop working cleanly. Nothing real of yours is kept, and this cannot be undone.</p>
  </div>
  <form method="post" action="/dashboard/delete">
    <label for="password">Confirm with your password</label>
    <input id="password" name="password" type="password" required maxlength="200">
    <button class="danger">Delete everything</button>
  </form>
  <p><a href="/dashboard">← Back to the dashboard</a></p>`;
  return layout("Delete account", body);
}

function notFoundPage(message) {
  return layout("Not found", `<h1>Not found</h1><p class="muted">${esc(message || "This page does not exist.")}</p><p><a href="/">Home</a></p>`);
}

function errorPage(message) {
  return layout("Something went wrong", `<h1>Something went wrong</h1><div class="error">${esc(message)}</div><p><a href="/">Home</a></p>`);
}

module.exports = {
  esc,
  layout,
  CALENDAR_NOTE,
  homePage,
  signupPage,
  loginPage,
  dashboardPage,
  eventPickerPage,
  eventTypeFormPage,
  upgradePage,
  paymentInstructionsPage,
  bookingPage,
  bookingFormPage,
  confirmedPage,
  cancelConfirmPage,
  cancelledPage,
  reschedulePage,
  deleteAccountPage,
  notFoundPage,
  errorPage,
  commonZones,
  zoneOptions,
  calendarNote,
  agoLabel,
};
