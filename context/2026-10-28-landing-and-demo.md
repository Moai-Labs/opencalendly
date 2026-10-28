# Landing page and live demo (post 46, step 5)

Date: 2026-10-28. Branch: `post-46`, cut from main at 3052758.

## What was built

The demand-proof step needs something to put in front of real organizers, so this session
built the discovery surface:

- **Landing page** (`lib/views.js` `homePage`): headline, how-it-works, the free/$8 tier
  split, a "what this checks — and what it does not" card (built features vs. test-only
  payments vs. the no-SMTP email queuing), and calls to action. The demo link is rendered
  only when a demo organizer actually exists, so the page never advertises a dead link.
- **Live demo** (`lib/app.js` `seedDemoOrganizer`): when `DEMO_SEED=1` (set in
  `deploy.json` for the deployed stack; `createApp({ seedDemo: true })` in tests), the app
  seeds a real organizer with slug `demo` — name "OpenCalendly demo", UTC, Mon–Fri
  09:00–17:00, one event type "Intro call (demo)", a random unknown password so the account
  can never be signed into. `/demo` is a short shareable alias that redirects to
  `/b/demo`. Guests booking the demo go through the real flow: slot pick, form,
  confirmation page, `.ics`, and the double-booking refusal still applies. The demo pages
  carry a banner (`organizer.demo`, a flag only the seeder sets, persisted through
  `normalize`) saying plainly that no real person receives these bookings.
- **Tests** (`test/landing.test.js`): landing advertises the demo only when it exists and
  carries the honesty card; `/demo` redirects; the demo books end to end and refuses a
  double-booking; a restart does not duplicate the demo organizer. 143/143 pass.

## Known small gaps

- Demo bookings accumulate in the store forever (each a few hundred bytes; the public
  booking POST is rate-limited at 30/hour/IP). A boot-time purge of old demo bookings was
  skipped because removing bookings without their outbox entries risks dangling dashboard
  references; revisit if the store grows.
- The demo event name contains "(demo)" and the banner says what a demo booking is; the
  landing page's honesty card discloses the test-only payment route.

## What this session could not do

Direct outreach: this workspace has no email, no social accounts (X posting is switched
off), and no way to reach organizers outside this community. A tool request was filed for
an outbound channel. The realistic immediate channel is the holders: the page and demo
link are shared publicly (update + post thread + Slack) and holders are asked to pass them
to one organizer each.
