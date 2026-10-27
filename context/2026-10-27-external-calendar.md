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

- 137 automated tests pass on the current head (81 before the calendar step,
  56 for it): parser
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
- A live run of the real server booted from this branch (2026-10-27, this
  workspace, feed on loopback via the test-only `allowPrivateFeeds` switch —
  the same steps the dev-stack run repeats, with an https feed there):
  signup → availability (09:00–17:00 UTC daily, 30-minute slots) → connect
  `http://127.0.0.1:4591/calendar.ics` (probed and parsed before save, 303,
  dashboard shows the calendar name and never the full address) → booking
  page for the next day with the feed's busy interval 10:00–11:00 UTC: the
  10:00 and 10:30 slots are not offered, the 09:30–10:00 slot correctly
  remains (it ends as the busy time begins), 14:00 is offered, and the page
  note reads "Times the organizer's external calendar shows busy are already
  hidden from this page (checked just now). The organizer's calendar can
  still change after you book." → a direct booking POST for
  `…T10:00:00Z` is refused (409) → a direct POST for 14:00 succeeds (303)
  and its confirmation page states "Times the organizer's external calendar
  shows busy were hidden when this booking was made (checked just now)."
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

## Review round 3 (2026-10-27)

The review asked for two things; the state of each:

1. **Unneeded response bodies in the fetcher.** Made. `requestAt` used to
   `res.resume()` the bodies of redirect and error responses — an unbounded
   drain outside MAX_FEED_BYTES, with the timeout cleared at `finish`, and a
   socket plus bandwidth still busy while the next redirect hop started.
   Redirect and error bodies are now never read: the connection is destroyed
   at once, so nothing can stream at us outside the cap and no socket
   outlives the hop. The promise is settled before the destroy, so the close
   cannot clobber the redirect/error outcome. Two regression tests serve
   responses (302 and 503) whose bodies stream forever and assert the
   server-side connection closes promptly with bounded bytes; under the old
   behavior those tests hang — the connection never closes — which is the
   bug the review found, demonstrated. Full suite: 137 automated tests pass.
2. **Prerequisites and the dev-stack test.** The unmerged state is kept:
   this branch stays unmerged until Steps 1–3 are separately merged and
   verified, and it rebases onto those merges before its own (see the
   Prerequisites section above — only the platform can perform those
   merges, and the operator requests stand on posts 20, 21 and 22). The
   dev-stack verification is still outstanding, and this session could not
   obtain it: the dev stack deploys from a pushed branch at session end, no
   preview address exists yet, and the dev-stack host does not resolve from
   this workspace, so there is nothing to test against from here. The
   operator has been asked (on the post's thread) to run the booking-page
   test against the deployed preview once it exists. What that run must
   show, unchanged from the plan above: a connected feed's busy interval is
   hidden on the booking page, a direct booking POST against it is refused
   (409), and the page's note states when the calendar was last checked.
   Nothing is claimed as dev-stack-verified until that has run and its
   actual results are recorded in this file.

## Review round 4 (2026-10-27)

The review asked that this record show the branch held to its prerequisites
and the dev-stack verification obtained before merge approval is requested.
The state of each part:

1. **The merge gate — kept, restated precisely.** This branch stays unmerged
   until Steps 1–3 are separately merged and verified, and it rebases onto
   those merged prerequisites before its own merge. The causality that fixes
   this order: the dev stack deploys from merged branches, and main carries
   no application code yet (only the platform template), so no preview of
   this product can exist until Steps 1–3 merge. The "Done when" of this
   post — a booking page that reflects external busy times tested on the dev
   stack — therefore cannot be satisfied from this lane until the operator
   merges Steps 1–3. The operator requests on posts 20, 21 and 22 stand
   unchanged, and the request to run the booking-page test on the deployed
   preview is on record in this post's thread. This is not a waiver; it is
   the reason the order is what it is.

2. **The deployment — not obtainable from this lane.** The preview target is
   named in the repo (`deploy.json`, `fly.toml`), but its fly.dev host does
   not resolve from this workspace — rechecked this session, DNS ENOTFOUND,
   retried — and building, pushing images and merging branches are platform
   work. A tool request was filed with the platform builders asking that the
   dev-stack preview address (and workspace network reachability to it) be
   surfaced after each push, so this required test can be run from here the
   moment a deployment exists.

3. **The behavior the dev-stack run must show — verified against the real
   server in this workspace.** The exact steps the dev-stack run will repeat
   were executed 2026-10-27 against a boot of this branch's server (see
   "Verified" above for the transcript: connect with probe and masking, busy
   10:00–11:00 UTC interval hides the 10:00 and 10:30 slots while 09:30–10:00
   and 14:00 remain, the last-check note on the page, 409 on a direct POST
   for the busy start, 303 for a free slot, the matching note on the
   confirmation page). Full suite on this head: 137 automated tests pass.

   This is workspace verification of the behavior, not the dev-stack run, and
   nothing is claimed as dev-stack-verified. Remaining limitations, honestly:
   the dev-stack run itself (same five steps against the deployed preview
   with a real https feed, results to be recorded here), which is blocked
   behind the Steps 1–3 merges and a deployment — both platform actions.
