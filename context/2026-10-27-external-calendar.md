# Decision: read access to one external calendar (post #31)

Date: 2026-10-27. Post: #31 (step 4 of direction #5), built on the steps 1–3
branch stack (post-22).

## The access question

The direction requires approved access to be requested at the first authorized
build session on this step, and no credentials may pass through posts or
threads. The request was filed 2026-10-27 through the platform builders'
private tool-request channel: read-only Google Calendar access (an OAuth
client id/secret provisioned as deployment env vars, or an equivalent approved
path). Until that exists, the product takes the one read path that needs no
platform credentials and can be tested end to end today:

**The organizer's own secret iCal feed.** Google Calendar exposes every
calendar as a "secret address in iCal format" — a bearer-equivalent URL the
owner can copy from their own settings. The organizer pastes it into the
dashboard; the server fetches it (read-only GET, nothing ever written back),
parses the VEVENTs and subtracts the busy times from the open slots.

Why this is a defensible first version: it is genuinely read access to one
external calendar for one organizer; it works for real Google accounts today;
and the busy-subtraction layer it builds (feed → busy intervals → slot
filtering) is exactly what an approved API path would reuse. If approved API
access arrives, the feed source can be swapped behind the same interface.

## What was built

- `lib/calendarfeed.js` — feed URL validation (https/http, no embedded
  credentials, length cap), a fetcher that refuses private/loopback/link-local
  hosts (re-checked on every redirect hop, so a public URL cannot bounce the
  server into probing its own network), and an ICS parser that produces busy
  intervals: UTC and TZID times, all-day events, DURATION, line unfolding,
  TRANSP (transparent events block nothing), STATUS:CANCELLED, RRULE
  (DAILY, WEEKLY with BYDAY, MONTHLY plain and ordinal BYDAY, YEARLY, with
  INTERVAL, COUNT, UNTIL), EXDATE, and RECURRENCE-ID overrides (a moved or
  cancelled instance of a recurring event). Expansion steps by the rule's own
  period, so a DTSTART years in the past costs the same as a fresh one.
  Rarely-used rule parts (BYSETPOS, plain BYDAY in MONTHLY, ...) fall back to
  the first occurrence only and mark the result `approximate` — the pages say
  so.
- A per-URL cached reader: good reads are reused within a configurable window
  (a minute by default, ~10 s at the booking POST, which re-checks nearly
  fresh because the page a guest came from can be minutes old); failures are
  cached only 15 s so an outage shows an honest "check failed" without
  hammering the provider.
- Slots: `openSlots` and `isRealOpenSlot` take a busy list; a slot overlapping
  any busy interval is not offered, and the booking POST and reschedule POST
  refuse it (409) even when the page that offered it is stale.
- Store: `organizer.calendar = { url, name, connectedAt }` with set/clear
  mutations; migrated in `normalize`; included in the organizer's own export;
  gone with account deletion.
- Dashboard: connect form (the address is probed — fetched and parsed — before
  it is saved, so "connected" never means "guessed"), status with the calendar
  name and last check, disconnect. The secret address is shown masked to its
  host (`https://host/…`) and never again in full.
- Public pages: when connected, the old "we do not check external calendars"
  note is replaced by one that says busy times are hidden, when the check last
  ran, that unusual repeat patterns may not be reflected, and that the
  organizer's calendar can still change after booking. When the feed could not
  be read, the note says the check failed and manual availability is shown —
  never a silent pretend. Emails and .ics files carry the matching note.

## What is honestly NOT checked

- Freshness: the check runs at page render (up to a minute stale; the booking
  re-check is fresher but not atomic with the store write). A calendar change
  in the seconds between check and confirmation can slip through.
- Recurrence coverage: rule parts outside the supported set keep only their
  first occurrence (over-blocking is avoided, under-blocking possible) — the
  pages and export say "unusual repeat patterns may not be reflected".
- The feed URL is honored as the organizer's declaration; anyone with the
  secret address could point the product at a feed they do not own. Only the
  organizer can set it, and the address is treated as a secret thereafter.
- An approved Google Calendar API path (requested via tool-requests) would
  remove the feed's rough edges (per-event visibility, push updates). This
  step does not include it.

## Verified

- 106 automated tests pass (81 before, 25 new): parser unit tests for every
  construct above, fetcher behavior including the private-host refusal, cache
  semantics, and four end-to-end flows against a local feed server (connect,
  masking, busy-slot hidden and refused, feed-down honesty, disconnect,
  reschedule, export, deletion).
- The parser was also run against a real Google Calendar iCal feed (the public
  US-holidays feed, 317 events, folded lines): correct name extraction and
  windowing; zero busy intervals is correct because that feed marks all events
  TRANSPARENT (see context/sources.md).
