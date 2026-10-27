# Decision: guest lifecycle — cancel, reschedule, data control (post #21)

Date: 2026-10-27. Post: #21 (Step 2 of direction #5).

## Choices and why

**Cancellation keeps the record, frees the slot.** A cancelled booking keeps its id,
guest fields and history, gains `status: "cancelled"` + `cancelledAt/By/Reason`; every
slot computation treats cancelled as free. The guest's confirmation link, cancel link
and calendar file all keep working and tell the truth (`STATUS:CANCELLED` in the ICS).
Cancelling twice is idempotent, not an error.

**Rescheduling keeps the booking id.** Same id means the guest's links and calendar URL
stay valid after a move. `previousStartMs/EndMs`, `rescheduledAt/By` record the move; a
re-pick of the same slot is a no-op and writes no second history entry. The conflict
check ignores the booking being moved (its old slot is being freed) and runs inside the
same store lock as every other mutation — so a reschedule racing another guest's booking
for one slot lets exactly one win. Two race levels are tested: at the store (both
enqueue orders) and over HTTP (concurrent POSTs).

**The confirmed page is the guest's control panel.** Cancel and reschedule links live on
the confirmation page (the email links there too), so a guest never needs to keep raw
URLs. A booking that was taken underneath a reschedule returns 409 with the slot picker
and the message "that time was just taken" — the same wording the booking page race
uses.

**Export: everything, minus secrets.** `GET /dashboard/export` streams JSON: organizer
record, all bookings, this organizer's outbox, `exportedAt`. Password hash and salt are
stripped at the source; the export returns copies, so a caller cannot mutate live state.

**Deletion: account gone, guest links still answer.** Deleting (password-confirmed)
removes the organizer and their outbox; their bookings become anonymous stubs — status
cancelled, guest name/email/note wiped. A guest's confirmation link then serves the
cancelled page with no event name and no data, and their `.ics` link serves a minimal
cancelled VCALENDAR with no attendees. Nothing real is held without an exit, and no
guest is stranded on a 404.

**Organizer-side control** (event name, slot duration, time zone, weekly hours) stays in
the dashboard availability form from Step 1; Step 2 adds the data panel (export/delete)
under it.

## Bugs the new tests caught

- The four Step 2 view functions were never exported (`module.exports`), so every cancel
  and reschedule page 500'd — invisible without tests.
- The confirmed page never received the `rescheduled` flag, so "Booking moved" never
  showed after a successful move.
- The dashboard's upcoming list included cancelled bookings.

## Testing

50 tests pass (`npm test`): Step 1's 40 plus 10 new ones — cancel frees the slot,
reschedule moves/frees/no-ops/refuses, the reschedule race at store and HTTP level,
cancelled bookings can't reschedule, export shape and secrecy, deletion and
anonymization, the organizer's dashboard flow over HTTP.
