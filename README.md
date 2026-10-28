# OpenCalendly

A dependable booking link. Organizers set manual availability and share a link; guests
book a slot without an account. Built in the open by an autonomous agent together with
the people who hold its token.

## What works today (booking core)

- Organizer signup/sign-in (private accounts, scrypt-hashed passwords, signed session cookies).
- Weekly availability (one window per weekday) with a slot duration, set in the organizer's time zone.
- A shareable booking page: guests pick a day and slot, and every slot shows the time in
  the guest's chosen time zone beside the organizer's zone.
- Guests book by name and email alone — no account. Double bookings are rejected, including
  simultaneous attempts (the conflict check and the write happen under one lock).
- A confirmation email per booking and a notification to the organizer. Without a connected
  mail server (SMTP_HOST env) emails queue in the organizer's dashboard instead of being
  silently dropped; with one, a minimal built-in SMTP client sends them.
- An .ics calendar file for every booking.
- Read access to one external calendar per organizer: paste your calendar's secret iCal
  address (Google Calendar → Settings → your calendar → "Secret address in iCal format")
  and the booking page hides the times that calendar shows busy. The feed is fetched
  read-only, cached briefly, and every page states when it was last checked. The address
  is stored but never shown in full again.
- All data persists in one JSON file written atomically on every change, and is restored on
  restart; the startup reads it before serving.

Honest boundaries of the external-calendar check, shown in the product itself: the check
runs when a page is served (results up to a minute old, and the booking itself is
re-checked nearly fresh, but the organizer's calendar can change right after); unusual
repeat patterns in the feed keep only their first occurrence, and the page says so; if
the feed cannot be read, the page says so and shows manual availability. Organizers
without a connected calendar still get the plain note that external calendars are not
checked.

## How it runs

- `Dockerfile` builds the product into one container image that serves on port 3000. Data
  lives in `/data` (the `DATA_DIR` env), backed by the service volume.
- `deploy.json` describes the services to run: their image, size, port and whether they are
  reachable from the internet. Changing this file is how the product's infrastructure changes.
- `.github/workflows/build.yml` runs on every push to the default branch: it builds the image,
  runs the tests (`npm test`, `node --test`), publishes the image to the GitHub container
  registry tagged with the commit, and records the result as `refs/ci/pass/<commit>` or
  `refs/ci/fail/<commit>`. An image named in `deploy.json` without a tag runs the commit
  being deployed.

## Development

- No runtime dependencies: Node 22 standard library only. `npm test` runs the suite
  (time-zone maths, slot generation, storage restore, double-booking races, the full
  HTTP flow, the SMTP client against a fake server, and the calendar feed parser,
  fetcher and booking-page integration against a local feed server).
- Run locally: `DATA_DIR=./data npm start` (or `node server.js`).
