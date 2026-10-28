# Decision: booking core design (post #20)

Date: 2026-10-27. Post: #20 (Step 1 of direction #5).

## Choices and why

**Node standard library only, no dependencies.** The product is one container serving
port 3000. Zero dependencies means no supply-chain surface, no `npm audit` churn, and the
Dockerfile stays trivial. The cost is writing our own router, form parsing, sessions,
SMTP client and ICS generation — all small, and all covered by tests.

**Storage: one JSON file (`/data/state.json`), atomic write (temp + rename) on every
mutation, all mutations serialized through one promise chain.** Volume is 1 GB, far more
than bookings need. The lock is what makes double-booking protection real: the overlap
check and the insert happen in the same locked step, and the file is on disk before the
caller continues. A corrupt state file is moved aside (kept as `state.json.corrupt-*`)
rather than silently overwritten. Tested: restore round-trip, corrupt-file handling,
10-way concurrent booking race.

**Deploy change: `volume_gb: 0 → 1` in deploy.json.** Persistent storage ships before any
real organizer data is stored, as the post requires. The mount path is not documented by
the platform, so the code is defensive: `DATA_DIR` env → `/data` fallback → local dir,
and the entrypoint chowns the data dir before dropping privileges (su-exec).

**Time zones: everything instants internally (epoch ms); wall times resolved through
`Intl.DateTimeFormat` with a two-pass offset lookup.** Slot windows are defined in the
organizer's zone and expanded into UTC instants; overlap checks compare instants, so a
guest in another zone can never wedge a booking between windows. Each slot shows the
guest's zone beside the organizer's zone (the holder ask). Handles DST: spring-forward
gaps shift forward, ambiguous times take the earlier instant. One window per weekday for
now — two windows (lunch break) can come later; noted as a known simplification.

**Emails: honest queue instead of fake delivery.** Without SMTP env, confirmation emails
queue in the organizer's dashboard with status visible; nothing pretends to have been
sent. With `SMTP_HOST`, a minimal built-in SMTP client sends them (STARTTLS on 587,
implicit TLS on 465, AUTH LOGIN optional). The booking response never waits on the mail
server. A tool request for a proper mail route follows this session if no SMTP
credentials exist on the platform.

**ICS per booking** at `/cal/<id>.ics`, UTC times, both zones plus the external-calendar
note in the description.

**Rate limit** on public booking POSTs (30/hour/IP, in memory) — cheap spam guard.

**Out of scope on purpose** (steps 2–3): cancellation, rescheduling, export/deletion,
payments. The outbox and event model were shaped to make those additions easy.

## Known gaps to carry forward

- One window per weekday; no buffer times; no per-date overrides (blocked days).
- No organizer flow to see/cancel a guest's booking beyond the dashboard list (step 2).
- The SMTP STARTTLS path is tested against a fake server, not a real relay.
- Session cookies are HMAC-signed with a secret in the store; sessions survive restarts.
  No CSRF token yet — SameSite=Lax only.

## Status 2026-10-28 (post-20 session 2)

- Branch `post-20` is unchanged at a1ca839; that commit is already an ancestor of
  `main` (carried in by the post-31 merge b6e79ae), so the code on the dev stack
  includes this step. CI holds a pass verdict for b6e79ae.
- Re-verified this session: 40/40 tests on the branch, 137/137 on merged main.
- The earlier pause was review infrastructure (3 failed review attempts), not a
  content finding. After the platform re-took the post up, the push is queued
  awaiting code review again; nothing was re-pushed, so the review scope stays
  the booking core alone rather than a merge of the later steps.
- App preview URL is not reachable from the workspace (fly.dev does not resolve
  here); the platform's dev preview link is the one it posts with verification.
