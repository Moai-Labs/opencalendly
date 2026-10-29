# Step 6: one truth about external calendars, walked in a real browser (post #53)

Date: 2026-10-29. Branch: `post-53` (cut from main at edaa65f).

## What the holder reported (post #51) and what was actually wrong

Feedback #51 found the live product contradicting itself. Root cause, stated honestly:
the previous steps' done standard was automated tests plus scripted HTTP walks; nobody
ever rendered the pages side by side. Three defects, all confirmed by walking the live
dev stack (still on edaa65f when this session started) in a real browser:

1. **The landing page's honesty card claimed calendar checking unconditionally** —
   "read-only checking of one external calendar, which hides the times it shows busy"
   under "Checked and built" — while booking pages said "We do not check external
   calendars". The truth is conditional: an external calendar is checked only when one
   is connected.
2. **The .ics description's "Your time" was in the organizer's zone.** The route that
   serves `/cal/:id.ics` passed `guestZone: organizer.timezone` (lib/app.js), so a
   guest in New York got "Your time: 09:00 (UTC)". The walk on the live stack
   reproduced it exactly; the guest's own confirmation page showed both zones
   correctly, so only the calendar file lied.
3. **The dashboard's empty-bookings row said "Share your link below"** while the share
   section sits above the table.

## The fix

- One statement of the truth, everywhere (`lib/views.js`): the no-calendar note now
  reads "No external calendar is connected, so nothing external is checked …". Two
  audiences, same truth: guests get "Keep your own calendar handy", the dashboard gets
  "Connect one in the calendar section below and its busy times are hidden". The
  landing card now has its own bullet, "External calendars — checked only when
  connected", and the built list no longer claims it unconditionally. The dashboard
  connect form leads with the same sentence.
- Bookings store `guestZone` (validated) at creation (`lib/store.js`); the `.ics`
  route resolves the guest zone in order: explicit `?tz=` on the link, then the zone
  the guest booked in, then the organizer's zone for bookings made before this was
  recorded.
- The empty-bookings row now says "Your booking link is above."

## The browser walk (test/browser-walk.mjs, committed)

Puppeteer driving headless Chrome, one pass, the way a user walks it, with
screenshots and a JSON log per run (kept in the workspace `walk/` directory):

- **Logged out**: landing → honesty card read verbatim → demo booking page → pick
  slot → form → confirmation → the .ics fetched in the browser.
- **Logged in**: sign-up (the form preselects the browser's zone — observed
  America/New_York) → dashboard → weekly hours set (all days 09:00–17:00 UTC) →
  connect a real public feed with a busy interval (Mon 2026-11-02 10:00–11:00 UTC) →
  the booking page hides the overlapping slots → a direct POST for the busy slot is
  refused 409 → a free slot books end to end, its .ics says the calendar was checked →
  disconnect → the busy slot is offered again → the account is deleted and the
  dashboard is unreachable afterwards.

**Local run on this branch (new code): 26 steps, 8/8 behavioural checks pass.**
The busy-hour note, the guest-zone .ics, the new landing card and the corrected
dashboard copy are all confirmed in rendered pages (screenshots).

**Live stack run on the old deployment: the step-4 booking-page test passes live**
(busy interval hidden, direct POST 409, "checked just now" note, disconnect restores,
deletion clean) — the operator request from post 31 is fulfilled. The same walk
reproduced both bugs live: the .ics "Your time" in UTC for a New York guest, and the
"Share your link below" copy, and recorded the contradictory copy verbatim.

## Walk environment notes (for re-running)

This workspace has no system Chrome; `test/browser-walk.mjs` needs
`CHROME_PATH`, `LD_LIBRARY_PATH` and `FONTCONFIG_FILE` pointing at a working
headless build (chrome-headless-shell 156 plus its .so deps and DejaVu fonts were
staged under /tmp this session — /tmp does not survive the session; expect to
re-stage). Without fonts, skia dies with `SkFontMgr_FontConfigInterface ... Not
implemented` on the second navigation. The walk's test feed is a public URL; the
feed fetcher's honest user-agent is blocked by some paste hosts (dpaste 403s it),
litter.catbox.moe serves it fine.

## What remains for the done condition

The live-stack walk above was against the pre-fix deployment. After this branch is
pushed and deployed, the same walk runs once more on the live stack; all-green there
plus the preview link in the thread is the done condition of post #53.
