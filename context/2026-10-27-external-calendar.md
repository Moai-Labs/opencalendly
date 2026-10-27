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
  credentials, length cap), and a hardened fetcher: hosts are resolved first
  and every resolved address is classified against private network space
  (canonical IPv4, IPv6 literals including the bracketed form a URL gives,
  IPv4-mapped and IPv4-compatible forms, NAT64 and 6to4-embedded addresses,
  link-local, ULA, multicast, documentation ranges; anything unclassifiable
  fails closed). The connection is then made to exactly the validated
  addresses — no second DNS lookup, so DNS rebinding between validation and
  connection cannot move it — while TLS still verifies the hostname via SNI.
  Every redirect hop is re-resolved and re-checked, and the body is counted
  as it streams so a feed past the size cap is cut off instead of buffered
  whole. The ICS parser produces busy intervals: UTC and TZID times, all-day
  events, DURATION, line unfolding, TRANSP (transparent events block
  nothing), STATUS:CANCELLED, RRULE (DAILY with BYDAY, WEEKLY with BYDAY and
  WKST, MONTHLY plain, plain-BYDAY and ordinal BYDAY, YEARLY, with INTERVAL,
  COUNT, UNTIL), EXDATE, and RECURRENCE-ID overrides (a moved or cancelled
  instance of a recurring event, attached by UID + RECURRENCE-ID even when
  the cancelled instance omits DTSTART). COUNT counts occurrences the rule
  actually generates — months without the 31st and non-leap Feb 29s do not
  count — and no occurrence is emitted before DTSTART. Occurrences are
  selected by overlap with the window, not by start time, so multi-day
  events and instances moved into the window still show. Expansion is
  bounded: it jumps to the window where every period yields a candidate, a
  hard step budget (200k steps per event) stops pathological rules and marks
  the result `approximate` instead of blocking the server. Text without a
  VCALENDAR envelope (an HTML error page, say) is a failed read, not an
  empty calendar. Rarely-used rule parts (BYSETPOS, weekday-of-year rules,
  ...) fall back to the first occurrence only and mark the result
  `approximate` — the pages say so.
- A cached reader keyed by URL *and* parsing zone, so two organizers on one
  feed (or one organizer who changes zone) never receive cached intervals
  computed in another zone: good reads are reused within a configurable
  window (a minute by default, ~10 s at the booking POST, which re-checks
  nearly fresh because the page a guest came from can be minutes old);
  failures are cached only 15 s so an outage shows an honest "check failed"
  without hammering the provider.
- Slots: `openSlots` and `isRealOpenSlot` take a busy list; a slot overlapping
  any busy interval is not offered, and the booking POST and reschedule POST
  refuse it (409) even when the page that offered it is stale.
- Store: `organizer.calendar = { url, name, connectedAt }` with set/clear
  mutations; migrated in `normalize`; included in the organizer's own export;
  gone with account deletion. Each booking also persists the outcome of the
  calendar check that actually ran when it was made (or last rescheduled):
  `booking.calendarCheck = { state: "checked" | "failed" | "none", checkedAt,
  approximate }` — so the claim travels with the booking instead of being
  inferred from the organizer's current connection.
- Dashboard: connect form (the address is probed — fetched and parsed — before
  it is saved, so "connected" never means "guessed"), status with the calendar
  name and last check, disconnect. The secret address is shown masked to its
  host (`https://host/…`) and never again in full.
- Public pages: when connected, the old "we do not check external calendars"
  note is replaced by one that says busy times are hidden, when the check last
  ran, that unusual repeat patterns may not be reflected, and that the
  organizer's calendar can still change after booking. When the feed could not
  be read, the note says the check failed and manual availability is shown —
  never a silent pretend. The confirmation page speaks from the booking's own
  recorded check; emails and .ics files carry the matching note per booking
  (checked, could not be checked, or no connection), so connecting or
  disconnecting later cannot rewrite what a guest was told.

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

- 130 automated tests pass (81 before the calendar step, 49 for it): parser
  unit tests for every construct above, address classification (IPv6
  loopback and mapped literals, hex and dotted embedded IPv4, NAT64, 6to4),
  fetch hardening (DNS-resolving-private refusal, the connection going only
  to the validated address, the streaming size cap, redirect following,
  HTML-response rejection), expansion correctness (weekday-only daily rules,
  WKST-aligned intervals, month-end and leap-day COUNT, ordinals never
  before DTSTART, the step budget), windowing (spanning occurrences, moved
  and cancelled overrides), cache-zone separation, and end-to-end flows
  against local feed servers (connect, masking, busy slot hidden and
  refused, feed-down honesty, disconnect, reschedule, export, deletion, and
  the per-booking check outcome surviving later disconnects).
- The parser was also run against a real Google Calendar iCal feed (the
  public US-holidays feed, 317 events, folded lines): correct name extraction
  and windowing; zero busy intervals is correct because that feed marks all
  events TRANSPARENT (see context/sources.md).

## Prerequisites and the dev-stack test (honest status)

Updated 2026-10-27 after review round 2 (all five requested changes are
made; see below).

- The post requires Steps 1–3 to be merged and verified before this work.
  They are NOT yet merged: review could not complete on branches post-20,
  post-21 and post-22 (three attempts), the operator was asked, and those
  posts are paused. This branch is therefore stacked on the post-22 head
  (036eac0), which carries the full steps 1–3 implementation; it cannot
  rebase onto merged prerequisites that do not exist yet. The moment steps
  1–3 merge, this branch rebases onto the result before its own merge. Until
  then this branch should not merge either: the stack would merge without
  its verified base. This is a platform-limitation fact, not a waiver.
- The dev-stack booking-page test has not run yet: the dev stack deploys
  from a pushed branch after review, not from this workspace — an
  operator-assisted run is needed. The planned test, to exercise on the
  deployed preview: connect a feed that contains a real busy interval inside
  the booking window, confirm the booking page hides that slot, confirm a
  direct booking POST against it is refused (409), and confirm the page's
  note states when the calendar was last checked. Nothing is claimed as
  dev-stack-verified until that has been done and recorded here.

## Review round 2 (2026-10-27)

All five requested changes were made on this branch:

1. **Duration-aware lookback.** `occasionsOf` widens the window's wall dates
   by the event's own duration (ceil(duration/1 day) + 1 day, plus one margin
   day) instead of a fixed two-day lookback, so a recurring multi-day event
   that began days before the window and is still busy inside it is
   enumerated. Regression test: a weekly 5-day occurrence starting Jan 6
   blocks a window opening Jan 9.
2. **WKST ordering.** Weekly candidates are emitted in the order of their
   offsets from WKST, not by weekday number; the horizon break now lands on
   the first day past it, never on a later weekday before an in-window
   earlier one, and COUNT keeps the earliest WKST-days first. Regression
   test: Sunday DTSTART, WKST=SU, BYDAY=SU,MO, COUNT=1 keeps the Sunday, with
   a horizon ending between Sunday and Monday.
3. **Feed-wide budget.** One step budget now belongs to the whole feed parse
   (400,000 steps) alongside the per-event cap (200,000): many small old
   recurring events cannot each re-spend a per-event allowance and stall the
   event loop; exhaustion marks the result approximate. Weekly rules
   fast-forward to the window with or without COUNT — each elapsed rule-week
   contributes exactly its named weekdays (week 0's pre-DTSTART days are
   discounted), so COUNT stays exact; plain DAILY fast-forwards the same way.
   Regression test: forty daily rules from the year 1000 stop on the feed
   budget quickly, and the old pathological-rule test now uses a BYDAY daily
   rule, which genuinely cannot be fast-forwarded.
4. **The approximate flag is spoken.** `calendarCheckNote` adds an explicit
   incomplete-recurrence warning to the checked-state note when
   `calendarCheck.approximate` is true; confirmation emails, reschedule
   emails (guest and organizer — these now carry the note at all), and .ics
   descriptions all draw from that one note, and the flag is persisted on the
   booking, so connecting or disconnecting later cannot rewrite it. Tests:
   the mailer unit test for all three messages, and an end-to-end flow
   (BYSETPOS feed → page discloses, ICS discloses, queued email discloses,
   warning survives disconnect).
5. **Record-keeping.** This file is that record: the honest prerequisite
   status above, the dev-stack test plan with nothing claimed as verified
   until it runs, and the limitations listed under "What is honestly NOT
   checked". The merge-order point — steps 1–3 first, rebase, then this
   branch — is stated; only the platform can perform those merges, and the
   request stands recorded in the posts.
