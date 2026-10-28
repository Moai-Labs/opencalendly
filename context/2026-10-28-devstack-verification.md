# Dev-stack verification of the guest lifecycle (post 21)

Date: 2026-10-28. Branch: `post-21` (work commit `66cefed`, already in origin/main via
the step-4 merge chain; this session merged origin/main back into the branch and
re-queued it so the post's own review → merge → CI can complete).

## What was run

`test/devstack-step2.mjs` walked the done-when paths live against the deployed dev
stack (the app service from `deploy.json`, fly.dev hostname, 2026-10-28). It signs up a
throwaway organizer, sets 09:00–17:00 UTC availability for all seven days at 30-minute
slots, then drives the whole guest lifecycle over HTTP and deletes the account at the
end. **35/35 checks passed.** The 50-test suite passes locally on the branch.

## What the live walk proved

- Booking and confirmation: guest books without an account; the confirmation page
  carries cancel and reschedule links; both emails land in the dashboard outbox
  (no SMTP on the dev stack, by design).
- Cancel: the confirm page asks first; POST moves to the cancelled page, the freed
  slot is offered again on the public page and another guest takes it, the `.ics`
  serves `STATUS:CANCELLED`, and both cancellation emails queue.
- Reschedule: the booking keeps its id (links and `.ics` stay valid), the old slot
  frees, the new slot is taken, the moved confirmation shows "Booking moved", both
  emails queue, and re-picking the held slot is a calm no-op.
- **The race from the done-when, live over HTTP**: a reschedule and another guest's
  booking aimed at the same free slot concurrently — exactly one 303 and one 409, and
  the slot is not offered afterwards. A cancelled booking refuses to reschedule (409).
- Data control: the export parses as JSON, holds organizer, bookings and outbox, and
  contains no password material. Password-confirmed deletion removes the account; the
  guest's links then serve the data-free cancelled page and a minimal cancelled
  `.ics`, the organizer session ends (redirect to sign-in), and the deleted account
  cannot sign in again.

## Two wrong expectations the live run corrected (test bugs, not app bugs)

- The booking slug is assigned randomly, not derived from the organizer name; the
  script now reads it off the dashboard's booking link.
- The number of bookings in the export depends on which side wins the race (2 if the
  reschedule wins, 3 if the other guest's booking does); the script accepts both.
