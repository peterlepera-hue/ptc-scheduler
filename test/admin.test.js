'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startApp, fixtureFiles, csv, STUDENTS, TEACHERS, SCHEDULES, SUPPORTS } = require('./helpers');
const jobs = require('../src/jobs');
const email = require('../src/email');
const { parseCsv } = require('../src/csv');

let app;
let admin;
before(async () => {
  app = await startApp();
  admin = await app.staff('office@school.org');
});
after(() => app.close());

const enc = (rows, name = 'f.csv') => ({ name, data: Buffer.from(csv(rows)).toString('base64') });

test('uploads with known errors: every error is reported and nothing imports', async () => {
  const students = STUDENTS.map((r) => [...r]);
  students[1][5] = ''; // missing primary email
  students[2][3] = '2016-13-01'; // bad date
  students.push(['1003', 'Dup', 'Kid', '2014-01-01', 'X', 'x@example.com', '', '']); // duplicate SIS ID
  students.push(['1010', 'No', 'Dob', '', 'Y', 'not-an-email', '', '']);
  const schedules = [...SCHEDULES, ['1001', 'HIST9-99'], ['9999', 'MATH6-03']];
  const teachers = [...TEACHERS, ['Ms. Noroom', 'noroom@school.org', 'ART-03', '']];
  const supports = [...SUPPORTS, ['1001', 'SPED', 'ghost@school.org', 'ENG6-02'], ['1001', 'GIFTED', 'jlee@school.org', 'ENG6-02'], ['1004', 'ELL', 'jlee@school.org', 'ENG6-02']];
  const r = await admin.post('/api/admin/upload/import', { files: { students: enc(students), schedules: enc(schedules), teachers: enc(teachers), supports: enc(supports) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, false);
  const msgs = r.body.errors.map((e) => `${e.row}: ${e.message}`).join('\n');
  for (const re of [
    /Primary Parent Email is missing \(SIS ID 1001\)/,
    /Date of Birth "2016-13-01" is not a real date/,
    /Duplicate SIS ID 1003/,
    /Date of Birth is missing \(SIS ID 1010\)/,
    /"not-an-email" is not a valid email/,
    /Course Section HIST9-99 has no teacher/,
    /SIS ID 9999 is not in Upload 1/,
    /Room Number is missing for Ms\. Noroom/,
    /Support teacher ghost@school\.org is not in Upload 3/,
    /Support Type must be SPED or ELL/,
    /SIS ID 1004 is not enrolled in ENG6-02/,
  ]) assert.match(msgs, re);
  // Row numbers point at the spreadsheet row (header is row 1).
  assert.ok(r.body.errors.some((e) => e.row === 2 && /Primary Parent Email/.test(e.message)));
  for (const t of ['students', 'teachers', 'guardians', 'enrollments', 'sections', 'supports']) {
    assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} should be empty`);
  }
});

test('a missing column is reported clearly', async () => {
  const teachers = TEACHERS.map((r) => r.slice(0, 3));
  const r = await admin.post('/api/admin/upload/validate', { files: { ...fixtureFiles(), teachers: enc(teachers) } });
  assert.equal(r.body.errors.length, 1);
  assert.match(r.body.errors[0].message, /Missing column\(s\): "room number"/);
});

test('a clean upload imports; .xlsx works the same as .csv; a title row above the header is fine', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow(['Student Demographics Report - generated 10/1/2026']);
  ws.addRow(STUDENTS[0]);
  for (const r of STUDENTS.slice(1)) {
    const row = [...r];
    // Real date cell, numeric SIS ID, hyperlinked email: what Excel exports look like.
    row[0] = Number(row[0]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(row[3])) row[3] = new Date(`${row[3]}T00:00:00Z`);
    row[5] = { text: row[5], hyperlink: `mailto:${row[5]}` };
    ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  const files = { ...fixtureFiles(), students: { name: 'students.xlsx', data: Buffer.from(buf).toString('base64') } };
  const v = await admin.post('/api/admin/upload/validate', { files });
  assert.deepEqual(v.body.errors, []);
  assert.equal(v.body.imported, false);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM students').get().n, 0, 'validate alone imports nothing');
  assert.deepEqual(v.body.summary, { students: 7, parents: 5, teachers: 9, sections: 11, enrollments: 16, supports: 1 });
  assert.ok(v.body.warnings.some((w) => /Duplicate row: SIS ID 1007 in MATH6-03/.test(w.message)));
  const r = await admin.post('/api/admin/upload/import', { files });
  assert.equal(r.body.imported, true);
  const maya = app.db.prepare("SELECT * FROM students WHERE sis_id = '1001'").get();
  assert.equal(maya.dob, '2014-03-22');
  assert.equal(app.db.prepare("SELECT dob FROM students WHERE sis_id = '1005'").get().dob, '2015-01-10');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE g.email = 'aruiz@example.com'").get().n, 2);
});

test('re-uploading updates records and keeps bookings', async () => {
  const ev = await admin.post('/api/admin/event', require('./helpers').eventInput());
  assert.equal(ev.status, 200);
  const times = app.slotTimes();
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const b = await andrea.post('/api/parent/bookings', { items: [{ teacher_id: app.teacherId('rpatel@school.org'), starts_at: times[0], student_id: app.studentId('1001') }] });
  assert.equal(b.body.results[0].ok, true);
  const idsBefore = app.db.prepare('SELECT id, sis_id FROM students ORDER BY id').all();
  // New student enrolls, Maya's name is corrected, Mr. Patel's room changes, Mr. Gray leaves.
  const students = [...STUDENTS.map((r) => [...r]), ['1011', 'New', 'Kid', '2014-04-04', 'New Parent', 'new@example.com', '', '']];
  students[1][1] = 'Maya-Rose';
  const teachers = TEACHERS.filter((r) => r[1] !== 'gray@school.org').map((r) => [...r]);
  teachers[1][3] = '216';
  const schedules = [...SCHEDULES.filter((r) => r[1] !== 'MUS-01'), ['1011', 'MATH6-03']];
  const files = { students: enc(students), schedules: enc(schedules), teachers: enc(teachers), supports: enc(SUPPORTS) };
  const r = await admin.post('/api/admin/upload/import', { files });
  assert.equal(r.body.imported, true, JSON.stringify(r.body.errors));
  const idsAfter = app.db.prepare('SELECT id, sis_id FROM students ORDER BY id').all();
  assert.deepEqual(idsAfter.slice(0, idsBefore.length), idsBefore, 'existing students keep their ids');
  assert.equal(idsAfter.length, idsBefore.length + 1);
  assert.equal(app.db.prepare("SELECT first_name FROM students WHERE sis_id = '1001'").get().first_name, 'Maya-Rose');
  assert.equal(app.db.prepare("SELECT room FROM teachers WHERE email = 'rpatel@school.org'").get().room, '216');
  assert.equal(app.db.prepare("SELECT active FROM teachers WHERE email = 'gray@school.org'").get().active, 0);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'active'").get().n, 1, 'booking kept');
  // The new student's parent can log in and see Mr. Patel; Mr. Gray's open slots are gone.
  const np = await app.parent('new@example.com', '2014-04-04');
  assert.deepEqual((await np.get('/api/parent/overview')).body.children[0].teachers.map((t) => t.name), ['Mr. Patel']);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM slots WHERE teacher_id = ?').get(app.teacherId('gray@school.org')).n, 0);
  // An admin-set room survives the next upload.
  await admin.post(`/api/admin/teachers/${app.teacherId('green@school.org')}/room`, { room: 'Library' });
  await admin.post('/api/admin/upload/import', { files });
  assert.equal(app.db.prepare("SELECT room FROM teachers WHERE email = 'green@school.org'").get().room, 'Library');
  // A re-upload that drops a booked student warns about it.
  const v = await admin.post('/api/admin/upload/validate', { files: { ...files, students: enc(students.filter((s) => s[0] !== '1001')), schedules: enc(schedules.filter((s) => s[0] !== '1001')) } });
  assert.ok(v.body.warnings.some((w) => /Maya-Rose Thompson \(SIS ID 1001\) is not in this upload but has 1 booked/.test(w.message)), JSON.stringify(v.body.warnings));
});

test('teacher unavailable: bookings cancelled in bulk, families emailed, slots blocked', async () => {
  const times = app.slotTimes();
  const chidi = await app.parent('chidi@example.com', '2015-01-10');
  await chidi.post('/api/parent/bookings', { items: [{ teacher_id: app.teacherId('rpatel@school.org'), starts_at: times[3], student_id: app.studentId('1004') }] });
  const patel = app.teacherId('rpatel@school.org');
  const r = await admin.post(`/api/admin/teachers/${patel}/unavailable`, { reason: 'Mr. Patel is out sick' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cancelled, 2);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM slots WHERE teacher_id = ? AND status = 'open'").get(patel).n, 0);
  for (const to of ['aruiz@example.com', 'chidi@example.com']) {
    const m = app.db.prepare('SELECT kind, text_body FROM emails WHERE to_email = ? ORDER BY id DESC LIMIT 1').get(to);
    assert.equal(m.kind, 'slot_cancelled');
    assert.match(m.text_body, /Mr\. Patel is out sick/);
  }
  const audit = app.db.prepare("SELECT * FROM audit_log WHERE action = 'teacher.unavailable'").get();
  assert.match(audit.actor, /admin:office@school.org/);
  // Undo for later tests.
  app.db.prepare("UPDATE slots SET status = 'open', block_reason = NULL WHERE teacher_id = ?").run(patel);
});

test('dashboard: booked vs available per teacher, families with no bookings, tried-to-book counts', async () => {
  const times = app.slotTimes();
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  await andrea.post('/api/parent/bookings', { items: [{ teacher_id: app.teacherId('green@school.org'), starts_at: times[0], student_id: app.studentId('1001') }] });
  const d = (await admin.get('/api/admin/dashboard')).body;
  const green = d.teachers.find((t) => t.email === 'green@school.org');
  assert.equal(green.booked, 1);
  assert.equal(green.open, 11);
  assert.equal(green.total, 12);
  const unbookedEmails = d.unbooked.map((u) => u.email);
  assert.ok(!unbookedEmails.includes('aruiz@example.com'));
  // David shares Maya with Andrea, so he is not "unbooked" either.
  assert.ok(!unbookedEmails.includes('dthompson@example.com'));
  assert.ok(unbookedEmails.includes('linh@example.com'));
});

test('exports: master schedule by teacher, room and family as CSV', async () => {
  for (const by of ['teacher', 'room', 'family']) {
    const res = await admin.get(`/api/admin/export/${by}.csv`, { raw: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), new RegExp(`master-schedule-by-${by}\\.csv`));
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel shows accents correctly');
    const text = bytes.toString('utf8');
    const rows = parseCsv(text);
    assert.ok(rows.length >= 2);
    assert.ok(text.includes('Andrea Ruiz'));
  }
  const green = await app.staff('green@school.org');
  const res = await green.get('/api/teacher/export.csv', { raw: true });
  const rows = parseCsv(await res.text()).filter((r) => r.length > 1);
  assert.equal(rows.length, 13);
  assert.equal(rows[1][3], 'Booked');
  assert.equal(rows[1][4], 'Maya-Rose Thompson');
});

test('CSV exports neutralize spreadsheet formulas', async () => {
  const { toCsv } = require('../src/csv');
  const out = toCsv(['a'], [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@x'], ['normal, with comma']]);
  assert.match(out, /'=HYPERLINK/);
  assert.match(out, /'\+1/);
  assert.match(out, /"normal, with comma"/);
});

test('booking-open email goes to every guardian; reminders and teacher summaries run once', async () => {
  const before = app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'booking_open'").get().n;
  const r = await admin.post('/api/admin/event/send-open-email', {});
  assert.equal(r.body.count, app.db.prepare("SELECT COUNT(DISTINCT g.id) n FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id AND s.active = 1 WHERE g.active = 1").get().n);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'booking_open'").get().n - before, r.body.count);
  const open = app.db.prepare("SELECT text_body FROM emails WHERE kind = 'booking_open' AND to_email = 'linh@example.com'").get();
  assert.match(open.text_body, /date of birth/);
  assert.match(open.text_body, /Please book by/);

  const ev = app.db.prepare('SELECT * FROM events WHERE is_current = 1').get();
  const remindAt = new Date(Date.now() + 3600e3).toISOString();
  app.db.prepare('UPDATE events SET reminder_times = ? WHERE id = ?').run(JSON.stringify([remindAt]), ev.id);
  assert.deepEqual(jobs.runDue(app.db, new Date()), [], 'nothing due yet');
  const later = new Date(Date.now() + 2 * 3600e3);
  const ran = jobs.runDue(app.db, later);
  assert.ok(ran.some((x) => x.startsWith('reminder:')), JSON.stringify(ran));
  assert.deepEqual(jobs.runDue(app.db, later).filter((x) => x.startsWith('reminder:')), [], 'runs once');
  const rem = app.db.prepare("SELECT * FROM emails WHERE kind = 'conference_reminder' AND to_email = 'aruiz@example.com'").get();
  assert.ok(rem);
  assert.match(rem.text_body, /Room/);
  assert.match(rem.text_body, /main doors on Elm St/);
  assert.match(rem.ics, /BEGIN:VEVENT/);
  // Families without bookings get no conference reminder.
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'conference_reminder' AND to_email = 'linh@example.com'").get().n, 0);

  // Nudge 2 days before close, to families with nothing booked.
  const nudgeTime = new Date(Date.parse(ev.booking_closes_at) - 47 * 3600e3);
  const ran2 = jobs.runDue(app.db, nudgeTime);
  assert.ok(ran2.some((x) => x.startsWith('nudge:')));
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'booking_nudge' AND to_email = 'linh@example.com'").get().n, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'booking_nudge' AND to_email = 'aruiz@example.com'").get().n, 0);

  // Teacher summary when booking closes.
  const ran3 = jobs.runDue(app.db, new Date(Date.parse(ev.booking_closes_at) + 60e3));
  assert.ok(ran3.some((x) => x.startsWith('teacher_summary_close:')));
  const sum = app.db.prepare("SELECT text_body FROM emails WHERE kind = 'teacher_summary' AND to_email = 'green@school.org'").get();
  assert.match(sum.text_body, /Maya-Rose Thompson \/ Andrea Ruiz/);
});

test('emails are sent by the worker, retried on failure, and failures are flagged per family', async () => {
  let fail = true;
  const sent = [];
  email.setTransportForTests({ async send(m) { if (fail && m.to_email === 'linh@example.com') throw new Error('mailbox unavailable'); sent.push(m.to_email); return 'id'; } });
  app.db.prepare("UPDATE emails SET status = 'sent'").run();
  const id = email.sendBookingNudge(app.db, require('../src/events').currentEvent(app.db), { name: 'Linh', email: 'linh@example.com' });
  email.sendBookingNudge(app.db, require('../src/events').currentEvent(app.db), { name: 'María', email: 'maria@example.com' });
  await email.sendDue(app.db);
  assert.ok(sent.includes('maria@example.com'));
  let row = app.db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  assert.equal(row.status, 'queued');
  assert.equal(row.tries, 1);
  assert.match(row.last_error, /mailbox unavailable/);
  // Keep failing until it gives up.
  for (let i = 0; i < 6; i++) {
    app.db.prepare("UPDATE emails SET next_try_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    await email.sendDue(app.db);
  }
  row = app.db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.equal(app.db.prepare("SELECT email_status FROM guardians WHERE email = 'linh@example.com'").get().email_status, 'failed');
  const d = (await admin.get('/api/admin/dashboard')).body;
  assert.ok(d.badEmails.some((g) => g.email === 'linh@example.com'));
  // Resend from the admin page.
  fail = false;
  const rs = await admin.post(`/api/admin/emails/${id}/resend`, {});
  assert.equal(rs.status, 200);
  await email.sendDue(app.db);
  assert.equal(app.db.prepare('SELECT status FROM emails WHERE id = ?').get(rs.body.id).status, 'sent');
  email.setTransportForTests(null);
});

test('bounce webhook marks the family so the office can call', async () => {
  process.env.EMAIL_WEBHOOK_SECRET = 'x';
  require('../src/config').emailWebhookSecret = 's3cret';
  const c = app.client();
  const bad = await c.post('/api/webhooks/email-events', [{ email: 'chidi@example.com', type: 'bounce' }], { headers: { 'x-webhook-secret': 'nope' } });
  assert.equal(bad.status, 403);
  const ok = await c.post('/api/webhooks/email-events', [{ email: 'chidi@example.com', type: 'bounce', reason: 'Mailbox full' }], { headers: { 'x-webhook-secret': 's3cret' } });
  assert.equal(ok.status, 200);
  assert.equal(app.db.prepare("SELECT email_status FROM guardians WHERE email = 'chidi@example.com'").get().email_status, 'bounced');
});

test('every admin and teacher change is in the audit log', async () => {
  const log = (await admin.get('/api/admin/audit')).body.entries;
  const actions = new Set(log.map((e) => e.action));
  for (const a of ['import', 'event.create', 'booking.create', 'booking.cancel', 'teacher.unavailable', 'email.booking_open', 'teacher.room', 'login']) {
    assert.ok(actions.has(a), a);
  }
});

test('purge deletes family data after the event', async () => {
  const bad = await admin.post('/api/admin/purge', { confirm: 'yes' });
  assert.equal(bad.status, 400);
  const r = await admin.post('/api/admin/purge', { confirm: 'DELETE ALL FAMILY DATA' });
  assert.equal(r.status, 200);
  for (const t of ['students', 'guardians', 'bookings', 'attempts', 'emails']) assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  assert.ok(app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'purge'").get().n === 1);
});
