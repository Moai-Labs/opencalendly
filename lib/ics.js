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
function bookingIcs({ organizer, booking, baseUrl, guestZone }) {
  const summary = `${organizer.event.name}: ${organizer.name} and ${booking.guestName}`;
  const description =
    `${organizer.event.name} with ${organizer.name}.\n` +
    `Organizer time: ${time.describeInZone(booking.startMs, organizer.timezone)}\n` +
    `Your time: ${time.describeInZone(booking.startMs, guestZone)}\n` +
    `Manage or view: ${baseUrl}/b/${organizer.slug}/confirmed/${booking.id}\n` +
    `Note: external calendars are not checked.`;
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
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

module.exports = { bookingIcs };
