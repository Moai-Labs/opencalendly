// Live dev-stack walk of post-21 done-when paths.
// Usage: node step2-devstack-test.mjs <baseUrl>
const BASE = process.argv[2] || "https://fl-dev-1ec8a632-9802-40e2-9570-8d87fed7f9a1.fly.dev";
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function call(method, path, body, { manual = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: manual ? "manual" : "follow",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") || "" };
}
function extractStarts(html) {
  return [...html.matchAll(/[?&]start=([^&"']+)/g)].map((m) => decodeURIComponent(m[1]));
}

// 1. Sign up a fresh organizer.
const rand = Math.random().toString(36).slice(2, 8);
const email = `step2check-${rand}@example.com`;
const password = "devstack-check-1";
const su = await call("POST", "/signup", { name: "Step2 Check", email, password, timezone: "UTC" });
ok("signup accepted", su.status === 303 && su.location === "/dashboard", `status ${su.status}`);
const dash0 = await call("GET", "/dashboard", null, { manual: false });
const slug = (dash0.text.match(/\/b\/([a-z0-9-]+)</) || [])[1];
ok("dashboard shows booking link", !!slug, `slug ${slug || "?"}`);

// 2. Set availability: all seven days 09:00–17:00 UTC, 30-minute slots.
const av = { event_name: "Step2 Devstack Check", duration: "30", timezone: "UTC" };
for (let dow = 1; dow <= 7; dow++) { av[`d${dow}_s`] = "09:00"; av[`d${dow}_e`] = "17:00"; }
const avRes = await call("POST", "/availability", av);
ok("availability saved", avRes.status === 303 && avRes.location.startsWith("/dashboard?saved=1"), `status ${avRes.status}`);

// 3. Guest A books the first slot.
const page = await call("GET", `/b/${slug}?tz=UTC`, null, { manual: false });
const starts = extractStarts(page.text);
ok("booking page lists slots", starts.length >= 4, `${starts.length} slots`);
const [slot1, slot2, slot3] = starts;
const bookA = await call("POST", `/b/${slug}/book`, { start: slot1, tz: "UTC", guest_name: "Guest A", guest_email: `guest-a-${rand}@example.com`, guest_note: "" });
const idA = bookA.location.split("/confirmed/")[1]?.split("?")[0];
ok("guest A books slot 1", bookA.status === 303 && !!idA, `status ${bookA.status}`);

// 4. Confirmation page shows cancel and reschedule links.
const conf = await call("GET", `/b/${slug}/confirmed/${idA}?tz=UTC`, null, { manual: false });
ok("confirmation shows cancel link", conf.text.includes(`/b/${slug}/cancel/${idA}`));
ok("confirmation shows reschedule link", conf.text.includes(`/b/${slug}/reschedule/${idA}`));
const dash1 = await call("GET", "/dashboard", null, { manual: false });
ok("guest confirmation email queued", dash1.text.includes("Confirmed: Step2 Devstack Check"));
ok("organizer notification queued", dash1.text.includes("New booking: Guest A"));

// 5. Cancel: two-step confirm, then cancelled page; ics says cancelled.
const cGet = await call("GET", `/b/${slug}/cancel/${idA}?tz=UTC`, null, { manual: false });
ok("cancel asks for confirmation", cGet.status === 200 && cGet.text.includes("Cancel this booking"));
const cPost = await call("POST", `/b/${slug}/cancel/${idA}`, {});
const cId = cPost.location.split("/cancelled/")[1]?.split("?")[0];
ok("cancel redirects to cancelled page", cPost.status === 303 && !!cId, `status ${cPost.status}`);
const cPage = await call("GET", `/b/${slug}/cancelled/${idA}?tz=UTC`, null, { manual: false });
ok("cancelled page serves", cPage.status === 200 && cPage.text.toLowerCase().includes("cancelled"));
const icsA = await call("GET", `/cal/${idA}.ics`, null, { manual: false });
ok("ics marked cancelled", icsA.text.includes("STATUS:CANCELLED"));
ok("cancellation emails queued", (await call("GET", "/dashboard", null, { manual: false })).text.includes("Cancelled: Step2 Devstack Check"));

// 6. The freed slot is bookable again — guest B takes it.
const page2 = await call("GET", `/b/${slug}?tz=UTC`, null, { manual: false });
ok("freed slot offered again", extractStarts(page2.text).includes(slot1));
const bookB = await call("POST", `/b/${slug}/book`, { start: slot1, tz: "UTC", guest_name: "Guest B", guest_email: `guest-b-${rand}@example.com`, guest_note: "" });
const idB = bookB.location.split("/confirmed/")[1]?.split("?")[0];
ok("guest B re-books freed slot", bookB.status === 303 && !!idB && idB !== idA, `status ${bookB.status}`);

// 7. Reschedule: guest B moves to slot 2; id kept; old slot freed.
const rPost = await call("POST", `/b/${slug}/reschedule/${idB}`, { start: slot2, tz: "UTC" });
ok("reschedule succeeds", rPost.status === 303 && rPost.location.includes(`confirmed/${idB}`) && rPost.location.includes("rescheduled=1"), `status ${rPost.status}`);
const confB = await call("GET", `/b/${slug}/confirmed/${idB}?tz=UTC&rescheduled=1`, null, { manual: false });
ok("moved confirmation shows it moved", confB.status === 200 && confB.text.includes("Booking moved"), `status ${confB.status}`);
const page3 = await call("GET", `/b/${slug}?tz=UTC`, null, { manual: false });
const nowOpen = extractStarts(page3.text);
ok("old slot freed after move", nowOpen.includes(slot1));
ok("new slot taken after move", !nowOpen.includes(slot2));
const dash2 = await call("GET", "/dashboard", null, { manual: false });
ok("reschedule emails queued", dash2.text.includes("Rescheduled: Step2 Devstack Check") && dash2.text.includes("Booking rescheduled: Guest B"));
// Re-picking the held slot is a calm no-op.
const rNoop = await call("POST", `/b/${slug}/reschedule/${idB}`, { start: slot2, tz: "UTC" });
ok("re-picking held slot is a no-op", rNoop.status === 303, `status ${rNoop.status}`);

// 8. THE RACE: guest B reschedules onto slot 3 while guest C books slot 3.
const raceBook = fetch(BASE + `/b/${slug}/book`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ start: slot3, tz: "UTC", guest_name: "Guest C", guest_email: `guest-c-${rand}@example.com`, guest_note: "" }).toString(),
});
const raceResched = fetch(BASE + `/b/${slug}/reschedule/${idB}`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
  body: new URLSearchParams({ start: slot3, tz: "UTC" }).toString(),
});
const [rb, rr] = await Promise.all([raceBook, raceResched]);
const rbText = await rb.text(), rrText = await rr.text();
const winners = [rb.status, rr.status].filter((s) => s === 303).length;
const losers409 = [rb.status, rr.status].filter((s) => s === 409).length;
ok("race: exactly one wins", winners === 1 && losers409 === 1, `book=${rb.status} reschedule=${rr.status}`);
const page4 = await call("GET", `/b/${slug}?tz=UTC`, null, { manual: false });
ok("race: slot 3 not offered after", !extractStarts(page4.text).includes(slot3));
// Cancelled bookings cannot reschedule.
const rCancelled = await call("POST", `/b/${slug}/reschedule/${idA}`, { start: slot1, tz: "UTC" });
ok("cancelled booking cannot reschedule", rCancelled.status === 409, `status ${rCancelled.status}`);

// 9. Export: full JSON, no password material.
const exp = await call("GET", "/dashboard/export", null, { manual: false });
let data = null;
try { data = JSON.parse(exp.text); } catch {}
ok("export parses as JSON", !!data);
ok("export has organizer, bookings, outbox", !!data && !!data.organizer && Array.isArray(data.bookings) && Array.isArray(data.outbox));
ok("export carries no password material", !!data && !JSON.stringify(data).match(/hash|salt/i));
ok("export lists exactly this organizer's bookings", !!data && (data.bookings.length === 2 || data.bookings.length === 3) && data.bookings.every((b) => b.guestEmail.includes(rand) || b.status === "cancelled"), `${data ? data.bookings.length : "?"} bookings`);

// 10. Deletion: password-confirmed; guests land on a data-free cancelled page.
const dGet = await call("GET", "/dashboard/delete", null, { manual: false });
ok("delete asks for password", dGet.status === 200 && dGet.text.includes("password"));
const dPost = await call("POST", "/dashboard/delete", { password });
ok("deletion accepted", dPost.status === 303, `status ${dPost.status}`);
const gone = await call("GET", `/b/${slug}/confirmed/${idB}?tz=UTC`, null, { manual: false });
ok("guest link survives deletion, no data", gone.status === 200 && gone.text.toLowerCase().includes("cancelled") && !gone.text.includes("Step2 Devstack Check") && !gone.text.includes("Guest B"));
const goneIcs = await call("GET", `/cal/${idB}.ics`, null, { manual: false });
ok("ics survives deletion, minimal", goneIcs.status === 200 && goneIcs.text.includes("STATUS:CANCELLED") && !goneIcs.text.includes("Guest B"));
const dashGone = await call("GET", "/dashboard");
ok("organizer session ends after deletion", dashGone.status === 303 && dashGone.location === "/login", `status ${dashGone.status} ${dashGone.status !== 303 ? "body: " + dashGone.text.slice(0, 300).replace(/\s+/g, " ") : ""}`);
const goneLogin = await call("POST", "/login", { email, password });
ok("deleted organizer cannot sign in", goneLogin.status !== 303 || !goneLogin.location.includes("dashboard"), `status ${goneLogin.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
