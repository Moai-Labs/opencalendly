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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — OpenCalendly</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <a class="brand" href="/">OpenCalendly</a>
  <nav class="links">${links}</nav>
</header>
<main class="${opts.wide ? "wide" : ""}">
${body}
</main>
<footer>OpenCalendly — simple booking links. No external calendar access.</footer>
</body>
</html>`;
}

function homePage() {
  const body = `
  <h1>A dependable booking link</h1>
  <p>Set your weekly availability once, share one link, and let clients pick a time —
     no account needed for them, and no double bookings for you.</p>
  <div class="card">
    <h2>For organizers</h2>
    <p>Create a private account, set your hours in your own time zone, and share your page.</p>
    <p><a href="/signup">Create an account</a> · <a href="/login">Sign in</a></p>
  </div>
  <p class="muted">${esc(CALENDAR_NOTE)}</p>`;
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

function dashboardPage({ organizer, baseUrl, bookings, outbox, mailConfigured, flash = null, error = null }) {
  const windows = organizer.event.availability || {};
  const upcoming = bookings
    .filter((b) => b.endMs > Date.now())
    .sort((a, b) => a.startMs - b.startMs);
  const bookingRows = upcoming.length
    ? upcoming
        .map(
          (b) => `<tr>
        <td>${esc(time.describeInZone(b.startMs, organizer.timezone))}</td>
        <td>${esc(b.guestName)}<br><span class="muted">${esc(b.guestEmail)}</span>${b.guestNote ? `<br><span class="muted">“${esc(b.guestNote)}”</span>` : ""}</td>
        <td><a href="/cal/${esc(b.id)}.ics">calendar file</a></td>
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
  <p class="muted">Guests see your availability in their own time zone, next to yours. ${esc(CALENDAR_NOTE)}</p>

  <h2>Event &amp; availability</h2>
  <form method="post" action="/availability">
    <label for="event_name">Event name</label><input id="event_name" name="event_name" maxlength="60" required value="${esc(organizer.event.name)}">
    <div class="row">
      <div><label for="duration">Slot duration</label><select id="duration" name="duration">${durationOptions(organizer.event.durationMinutes)}</select></div>
      <div><label for="timezone">Your time zone</label><select id="timezone" name="timezone">${zoneOptions(organizer.timezone)}</select></div>
    </div>
    <h2>Weekly hours</h2>
    <p class="muted">One window per day, in <strong>${esc(organizer.timezone)}</strong>. Leave both fields empty to close a day.</p>
    ${availabilityRows(windows)}
    <button>Save availability</button>
  </form>

  <h2>Bookings</h2>
  <table>
    <tr><th>When (your time zone)</th><th>Guest</th><th></th></tr>
    ${bookingRows}
  </table>

  <h2>Email</h2>
  ${mailPanel}`;
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
// with the organizer's zone beside each slot.
function bookingPage({ organizer, baseUrl, days, selectedDate, guestZone, error = null }) {
  const organizerLabel = `${time.offsetLabel(organizer.timezone, Date.now())}`;
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
          const o = time.zoneParts(organizer.timezone, s.startMs);
          const oEnd = time.zoneParts(organizer.timezone, s.endMs);
          const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
          return `<a class="slot" href="/b/${esc(organizer.slug)}/new?start=${encodeURIComponent(new Date(s.startMs).toISOString())}&amp;tz=${encodeURIComponent(guestZone)}">
            <span class="t">${hm(t)} – ${hm(tEnd)}</span>
            <span class="alt">${hm(o)} – ${hm(oEnd)} in ${esc(organizer.timezone)} ${esc(organizerLabel)}</span>
          </a>`;
        })
        .join("") +
      `</div>`
    : `<p class="muted">No open slots on this day. Pick another day above, or check back later.</p>`;

  const body = `
  <h1>${esc(organizer.event.name)}</h1>
  <p class="muted">Hosted by ${esc(organizer.name)} · ${organizer.event.durationMinutes} minutes</p>
  <form method="get" action="/b/${esc(organizer.slug)}" class="zonebar">
    <div><label for="tz">Show times in your time zone</label><select id="tz" name="tz">${zoneOptions(guestZone)}</select></div>
    <button class="small secondary">Update</button>
  </form>
  <p class="muted">Organizer's zone: <strong>${esc(organizer.timezone)} ${esc(organizerLabel)}</strong> — shown beside every slot.</p>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <div class="days">${dayTabs}</div>
  ${slotsHtml}
  <div class="note">${esc(CALENDAR_NOTE)}</div>`;
  return layout(`Book: ${organizer.event.name}`, body, {
    links: `<a href="/login">Organizer sign in</a>`,
  });
}

// Guest details form for the chosen slot.
function bookingFormPage({ organizer, startMs, guestZone, values = {}, error = null }) {
  const g = time.zoneParts(guestZone, startMs);
  const o = time.zoneParts(organizer.timezone, startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const body = `
  <h1>${esc(organizer.event.name)}</h1>
  <p>With ${esc(organizer.name)}</p>
  <div class="card">
    <strong>${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, startMs + organizer.event.durationMinutes * 60000)))}</strong>
    <span class="muted"> — your time (${esc(guestZone)})</span><br>
    <span class="muted">${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, startMs + organizer.event.durationMinutes * 60000)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${error ? `<div class="error">${esc(error)}</div>` : ""}
  <form method="post" action="/b/${esc(organizer.slug)}/book">
    <input type="hidden" name="start" value="${esc(new Date(startMs).toISOString())}">
    <input type="hidden" name="tz" value="${esc(guestZone)}">
    <label for="guest_name">Your name</label><input id="guest_name" name="guest_name" required maxlength="100" value="${esc(values.guest_name || "")}">
    <label for="guest_email">Your email</label><input id="guest_email" name="guest_email" type="email" required maxlength="120" value="${esc(values.guest_email || "")}">
    <label for="guest_note">Anything to add? (optional)</label><textarea id="guest_note" name="guest_note" maxlength="500" rows="3">${esc(values.guest_note || "")}</textarea>
    <button>Confirm booking</button>
  </form>
  <div class="note">${esc(CALENDAR_NOTE)}</div>
  <p><a href="/b/${esc(organizer.slug)}?tz=${encodeURIComponent(guestZone)}">← Pick a different time</a></p>`;
  return layout("Confirm your booking", body);
}

function confirmedPage({ organizer, booking, baseUrl, guestZone, emailStatus, rescheduled = false }) {
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
    <strong>${esc(organizer.event.name)}</strong> with ${esc(organizer.name)}<br>
    Booked for <strong>${esc(booking.guestName)}</strong><br>
    <span class="muted">${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))} — your time (${esc(guestZone)})</span><br>
    <span class="muted">${esc(dateOf(o))} · ${esc(hm(o))} – ${esc(hm(time.zoneParts(organizer.timezone, booking.endMs)))} — organizer's time (${esc(organizer.timezone)})</span>
  </div>
  ${emailLine}
  <p><a href="/cal/${esc(booking.id)}.ics">Add to your calendar (.ics)</a></p>
  <div class="note">${esc(CALENDAR_NOTE)}</div>`;
  return layout("Booking confirmed", body);
}

// "Are you sure?" page for cancelling a booking. The confirmation link in the
// email and the confirmed page both land here; cancelling frees the slot.
function cancelConfirmPage({ organizer, booking, baseUrl, guestZone, error = null }) {
  const g = time.zoneParts(guestZone, booking.startMs);
  const o = time.zoneParts(organizer.timezone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const body = `
  <h1>Cancel this booking?</h1>
  <p class="muted">${esc(organizer.event.name)} with ${esc(organizer.name)}</p>
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

function cancelledPage({ organizer, booking, baseUrl, guestZone }) {
  const g = time.zoneParts(guestZone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const anonymous = !booking.guestEmail; // organizer deleted their account; data is gone
  const body = `
  <h1>Booking cancelled</h1>
  <div class="card">
    <strong>${esc(organizer.event.name)}</strong> with ${esc(organizer.name)} — cancelled.<br>
    ${anonymous
      ? `<span class="muted">The organizer's account was deleted; the booking details are gone with it.</span>`
      : `<span class="muted">The cancelled slot was ${esc(dateOf(g))} · ${esc(hm(g))} – ${esc(hm(time.zoneParts(guestZone, booking.endMs)))} (${esc(guestZone)})</span>`}
  </div>
  <p>The time is free again. <a href="/b/${esc(organizer.slug)}?tz=${encodeURIComponent(guestZone)}">Book another time</a>.</p>`;
  return layout("Booking cancelled", body);
}

// Reschedule page: same day tabs and slot list as the booking page, but the
// chosen slot moves an existing booking instead of creating a new one. The
// guest's current time is shown for comparison.
function reschedulePage({ organizer, booking, baseUrl, days, selectedDate, guestZone, error = null }) {
  const g = time.zoneParts(guestZone, booking.startMs);
  const o = time.zoneParts(organizer.timezone, booking.startMs);
  const hm = (p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const dateOf = (p) => `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const organizerLabel = time.offsetLabel(organizer.timezone, Date.now());
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
  <p class="muted">${esc(organizer.event.name)} with ${esc(organizer.name)} · ${organizer.event.durationMinutes} minutes</p>
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
  <div class="note">${esc(CALENDAR_NOTE)}</div>`;
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
  bookingPage,
  bookingFormPage,
  confirmedPage,
  notFoundPage,
  errorPage,
  commonZones,
  zoneOptions,
};
