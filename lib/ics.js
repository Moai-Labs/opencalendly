// ICS (text/calendar) generation for a booking, on the standard library.
"use strict";

const time = require("./time");

function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 lines must be at most 75 octets; fold with a leading space.
function fold(line) {
  if (line.length <= 75) return line;
  const chunks = [];
  let rest = line;
  chunks.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    chunks.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return chunks.join("\r\n");
}

function stampUtc(ms) {
  const p = new Date(ms);
  return (
    p.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  );
}

// A booking's calendar file. Times are UTC; the description carries both zones
// and the honest note that external calendars are not checked.
// `event` is the event type the booking belongs to (an organizer may have
// several); callers resolve it from the booking's own snapshot, so a type that
// was renamed or deleted never turns into a different one here — a missing
// type just means the file says "Booking".
function bookingIcs({ organizer, booking, baseUrl, guestZone, event }) {
  const eventType = event || (booking.eventType && booking.eventType.name ? booking.eventType : null);
  const eventName = eventType ? eventType.name : "Booking";
  const summary = `${eventName}: ${organizer.name} and ${booking.guestName}`;
  const description =
    `${eventName} with ${organizer.name}.\n` +
    `Organizer time: ${time.describeInZone(booking.startMs, organizer.timezone)}\n` +
    `Your time: ${time.describeInZone(booking.startMs, guestZone)}\n` +
    `Manage or view: ${baseUrl}/b/${organizer.slug}/confirmed/${booking.id}\n` +
    `Note: ${
      organizer.calendar && organizer.calendar.url
        ? "times were checked against the organizer's external calendar when booked; calendars can change."
        : "external calendars are not checked."
    }`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenCalendly//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.id}@opencalendly`,
    `DTSTAMP:${stampUtc(booking.createdAt || Date.now())}`,
    `DTSTART:${stampUtc(booking.startMs)}`,
    `DTEND:${stampUtc(booking.endMs)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `ORGANIZER;CN=${icsEscape(organizer.name)}:mailto:${organizer.email}`,
    `ATTENDEE;CN=${icsEscape(booking.guestName)}:mailto:${booking.guestEmail}`,
    `LOCATION:${icsEscape("Online / details to be agreed")}`,
    booking.status === "cancelled" ? "STATUS:CANCELLED" : "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// The calendar file of a booking whose organizer deleted their account: still
// a real event the guest may hold, but cancelled and carrying no personal data.
function cancelledStubIcs(booking) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenCalendly//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.id}@opencalendly`,
    `DTSTAMP:${stampUtc(booking.createdAt || Date.now())}`,
    `DTSTART:${stampUtc(booking.startMs)}`,
    `DTEND:${stampUtc(booking.endMs)}`,
    "SUMMARY:Cancelled booking",
    `DESCRIPTION:The booking was cancelled because the organizer deleted their account.${"\n"}Note: external calendars are not checked.`,
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

module.exports = { bookingIcs, cancelledStubIcs };
