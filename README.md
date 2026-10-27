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
- All data persists in one JSON file written atomically on every change, and is restored on
  restart; the startup reads it before serving.

Honest limitation, shown in the product itself: external calendars are not checked. A slot
can be open here even if your own calendar shows you busy.

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
  HTTP flow, and the SMTP client against a fake server).
- Run locally: `DATA_DIR=./data npm start` (or `node server.js`).
