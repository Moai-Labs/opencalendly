// What a booking can honestly say about the external-calendar check that ran
// when it was made. The outcome is persisted on the booking at booking time
// (and refreshed at reschedule time); confirmation emails and calendar files
// read it from there instead of inferring history from the organizer's
// current connection state — connecting or disconnecting later must not
// rewrite what a guest was told.
"use strict";

const STATES = new Set(["checked", "failed", "none"]);

// The store shape the rest of the code can rely on, or null when nothing was
// recorded (bookings made before this was kept).
function normalizeCalendarCheck(check) {
  if (!check || !STATES.has(check.state)) return null;
  return {
    state: check.state,
    checkedAt: check.state !== "none" && Number.isFinite(Number(check.checkedAt)) ? Number(check.checkedAt) : null,
    approximate: Boolean(check.approximate) && check.state === "checked",
  };
}

// The note a confirmation email or a booking's calendar file carries. Truth
// per state: a check that ran, a check that failed, and a booking that never
// checked a calendar at all. A checked run that was incomplete — recurrence
// patterns the parser does not expand, or a feed too large to expand within
// its budget — says so: "checked" must not quietly claim more than ran.
function calendarCheckNote(booking) {
  const check = booking && booking.calendarCheck;
  if (!check || check.state === "none") return "this booking does not check the organizer's external calendars.";
  if (check.state === "checked") {
    const base = "times were checked against the organizer's external calendar when booked; calendars can change.";
    if (!check.approximate) return base;
    return `${base} The check was incomplete: unusual repeat patterns in that calendar may not have been hidden.`;
  }
  return "the organizer's external calendar could not be checked when this booking was made; the time follows the organizer's availability.";
}

module.exports = { normalizeCalendarCheck, calendarCheckNote };
