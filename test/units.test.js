'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');
const tz = require('../src/tz');
const { parseCsv, toCsv } = require('../src/csv');
const { parseDob } = require('../src/importer');
const email = require('../src/email');
const dbm = require('../src/db');
const events = require('../src/events');

test('school time zone: EDT and EST offsets, and the skipped DST hour', () => {
  assert.equal(tz.zonedToUtc('2026-10-15', '15:00').toISOString(), '2026-10-15T19:00:00.000Z');
  assert.equal(tz.zonedToUtc('2026-12-03', '15:00').toISOString(), '2026-12-03T20:00:00.000Z');
  assert.throws(() => tz.zonedToUtc('2027-03-14', '02:30'), /does not exist/);
  assert.equal(tz.localHM('2026-11-01T05:30:00.000Z'), '01:30');
  assert.equal(tz.localHM('2026-11-01T06:30:00.000Z'), '01:30'); // the repeated hour
  assert.equal(tz.fmtTime('2026-10-15T19:00:00.000Z'), '3:00 PM');
  assert.equal(tz.isoToLocalInput('2026-10-15T19:05:00.000Z'), '2026-10-15T15:05');
  assert.equal(tz.localInputToIso('2026-10-15T15:05'), '2026-10-15T19:05:00.000Z');
});

test('slots on a day that crosses the fall-back change are 10 real minutes apart', () => {
  const s = events.slotStartsForDay({ day: '2026-11-01', start_time: '00:00', end_time: '03:00' }, 10);
  for (let i = 1; i < s.length; i++) assert.equal(Date.parse(s[i].starts_at) - Date.parse(s[i - 1].starts_at) >= 10 * 60e3, true);
  for (const x of s) assert.equal(Date.parse(x.ends_at) - Date.parse(x.starts_at), 10 * 60e3);
  // Spring-forward: the missing hour simply has no slots.
  const sp = events.slotStartsForDay({ day: '2027-03-14', start_time: '01:00', end_time: '04:00' }, 30);
  assert.deepEqual(sp.map((x) => tz.localHM(x.starts_at)), ['01:00', '01:30', '03:00', '03:30']);
});

test('date validation', () => {
  assert.equal(tz.isValidYMD('2024-02-29'), true);
  assert.equal(tz.isValidYMD('2026-02-29'), false);
  assert.equal(tz.isValidYMD('2026-13-01'), false);
  assert.equal(parseDob('2014-03-22').value, '2014-03-22');
  assert.equal(parseDob('3/22/2014').value, '2014-03-22');
  assert.equal(parseDob('03/22/2014').value, '2014-03-22');
  assert.equal(parseDob('2014-03-22T00:00:00.000Z').value, '2014-03-22');
  assert.match(parseDob('22/03/2014').error, /not a real date/);
  assert.match(parseDob('3/22/14').error, /not a date/);
  assert.match(parseDob('').error, /missing/);
  assert.match(parseDob('2099-01-01').error, /future/);
  assert.match(parseDob('41720').error, /not a date/);
});

test('CSV parsing handles quotes, commas, newlines, CRLF and BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line1\nline2'], ['1', '', '3']]);
  const round = parseCsv(toCsv(['n'], [['García-López, María'], ['Nguyễn "Linh"']]));
  assert.deepEqual(round, [['n'], ['García-López, María'], ['Nguyễn "Linh"']]);
});

test('calendar files: escaped, folded at 75 bytes without breaking accented characters', () => {
  const ics = email.buildIcs([{ id: 7, starts_at: '2026-10-15T19:00:00.000Z', ends_at: '2026-10-15T19:10:00.000Z',
    summary: 'Conference: Ms. Nguyễn-Thị Phương Thảo (José García-López, Ana Nguyễn); bring notes', location: 'Room 214, 2nd floor', description: 'Line 1\nLine 2' }]);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261015T190000Z/);
  assert.match(ics, /DTEND:20261015T191000Z/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:Conference: Ms\. Nguyễn-Thị Phương Thảo \(José García-López\\, Ana Nguyễn\)\\; bring notes/);
  assert.match(unfolded, /LOCATION:Room 214\\, 2nd floor/);
  assert.match(unfolded, /DESCRIPTION:Line 1\\nLine 2/);
  assert.ok(!ics.includes('�'));
});

test('emails render long, accented and hyphenated names, and escape HTML', () => {
  const db = dbm.open(':memory:');
  db.exec(`INSERT INTO teachers (id, email, name, room) VALUES (1, 't@s.org', 'Mx. Ōkubo-Fitzgerald <b>', 'B-12');
    INSERT INTO students (id, sis_id, first_name, last_name, dob) VALUES (1, '1', 'José', 'García-López', '2014-01-01'), (2, '2', 'Nguyễn Thị Phương', 'Thảo-Anderson-Worthington', '2015-01-01');
    INSERT INTO guardians (id, email, name) VALUES (1, 'm@example.com', 'María José García-López de la Cruz');
    INSERT INTO student_guardians VALUES (1, 1, 'primary'), (2, 1, 'primary');
    INSERT INTO events (id, name, slot_minutes, booking_opens_at, booking_closes_at, is_current, created_at, location_note)
      VALUES (1, 'Fall Conferences', 10, '2026-01-01T00:00:00.000Z', '2026-10-14T00:00:00.000Z', 1, '2026-01-01', 'Door "C" & ramp');
    INSERT INTO event_days VALUES (1, '2026-10-15', '15:00', '17:00');
    INSERT INTO slots (id, event_id, teacher_id, starts_at, ends_at) VALUES (1, 1, 1, '2026-10-15T19:00:00.000Z', '2026-10-15T19:10:00.000Z');
    INSERT INTO bookings (id, event_id, teacher_id, student_id, guardian_id, starts_at, ends_at, created_by, created_at)
      VALUES (1, 1, 1, 1, 1, '2026-10-15T19:00:00.000Z', '2026-10-15T19:10:00.000Z', 't', 'now');
    INSERT INTO booking_slots VALUES (1, 1, 1, 'primary');
    INSERT INTO booking_students VALUES (1, 1), (1, 2);`);
  const ev = events.getEvent(db, 1);
  const id = email.sendFamilyConfirmation(db, ev, 1, 'booked');
  const m = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  assert.match(m.text_body, /Hello María José García-López de la Cruz/);
  assert.match(m.text_body, /Thursday, October 15, 2026, 3:00\sPM–3:10\sPM/);
  assert.match(m.text_body, /About: José García-López and Nguyễn Thị Phương Thảo-Anderson-Worthington/);
  assert.match(m.text_body, /Room B-12/);
  assert.match(m.html_body, /Mx\. Ōkubo-Fitzgerald &lt;b&gt;/);
  assert.ok(!/Ōkubo-Fitzgerald <b>/.test(m.html_body));
  assert.match(m.html_body, /Door &quot;C&quot; &amp; ramp/);
  assert.match(m.subject, /Your conference is booked: Fall Conferences/);
  assert.match(m.ics, /BEGIN:VEVENT/);
  db.close();
});
