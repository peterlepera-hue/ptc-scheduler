'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, eventInput, localDay, localInput } = require('./helpers');

let app;
let admin;
let T; // teacher ids
let S; // student ids
let times;

before(async () => {
  app = await startApp();
  admin = await app.setup();
  T = Object.fromEntries(['rpatel', 'green', 'brown', 'white', 'gray', 'kim', 'diaz', 'fox', 'jlee'].map((k) => [k, app.teacherId(`${k}@school.org`)]));
  S = Object.fromEntries(['1001', '1002', '1003', '1004', '1005', '1006', '1007'].map((k) => [k, app.studentId(k)]));
  times = app.slotTimes();
  assert.equal(times.length, 12);
});
after(() => app.close());

const item = (teacher, i, student, note = '') => ({ teacher_id: teacher, starts_at: times[i], student_id: student, note });

test('siblings who share a teacher get one meeting, counted once against the chosen child', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.brown, 0, S['1002'])] });
  assert.equal(r.body.results[0].ok, true);
  const ov = (await andrea.get('/api/parent/overview')).body;
  const maya = ov.children.find((c) => c.first_name === 'Maya');
  const leo = ov.children.find((c) => c.first_name === 'Leo');
  assert.equal(leo.used, 1);
  assert.equal(maya.used, 0);
  const b = ov.bookings.find((x) => x.teacher_id === T.brown);
  assert.deepEqual(b.students.map((s) => s.first_name).sort(), ['Leo', 'Maya']);
  // Both children show the same booking under Mr. Brown.
  assert.equal(maya.teachers.find((t) => t.teacher_id === T.brown).booking.id, b.id);
  assert.equal(leo.teachers.find((t) => t.teacher_id === T.brown).booking.id, b.id);
  // Trying to book Mr. Brown again (for the other child) is refused.
  const again = await andrea.post('/api/parent/bookings', { items: [item(T.brown, 5, S['1001'])] });
  assert.equal(again.body.results[0].ok, false);
  assert.equal(again.body.results[0].code, 'ALREADY_BOOKED');
  // Teacher sees one row naming both children.
  const brown = await app.staff('brown@school.org');
  const sched = (await brown.get('/api/teacher/schedule')).body;
  const rows = sched.slots.filter((s) => s.booking);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].booking.students.sort(), ['Leo Ruiz', 'Maya Thompson']);
  assert.equal(rows[0].booking.guardian_name, 'Andrea Ruiz');
  // Clean up for later tests.
  assert.equal((await andrea.post(`/api/parent/bookings/${b.id}/cancel`)).status, 200);
});

test('a parent with 2 children can book 8 in total, but never 5 for one child', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  // Maya: Patel, Green, Gray, Brown. Leo: White (covers Maya too, counted to Leo), Kim, Diaz, Fox.
  const items = [
    item(T.rpatel, 0, S['1001']), item(T.green, 1, S['1001']), item(T.gray, 2, S['1001']), item(T.brown, 3, S['1001']),
    item(T.white, 4, S['1002']), item(T.kim, 5, S['1002']), item(T.diaz, 6, S['1002']), item(T.fox, 7, S['1002']),
  ];
  const r = await andrea.post('/api/parent/bookings', { items });
  assert.deepEqual(r.body.results.map((x) => x.ok), [true, true, true, true, true, true, true, true]);
  const ov = (await andrea.get('/api/parent/overview')).body;
  assert.equal(ov.bookings.length, 8);
  for (const c of ov.children) assert.equal(c.used, 4);
  // A 5th for Maya (White is already booked, so try moving the count... there is no 5th teacher left for Maya
  // except via the secondary guardian). David books a 5th for Maya: refused.
  const david = await app.parent('dthompson@example.com', '2014-03-22');
  const r5 = await david.post('/api/parent/bookings', { items: [item(T.white, 9, S['1001'])] });
  assert.equal(r5.body.results[0].ok, false);
  assert.equal(r5.body.results[0].code, 'LIMIT_REACHED');
  // Cancel everything so later tests start clean.
  for (const b of ov.bookings) assert.equal((await andrea.post(`/api/parent/bookings/${b.id}/cancel`)).status, 200);
});

test('both guardians share the 4-per-child limit, even when they confirm at the same moment', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const david = await app.parent('dthompson@example.com', '2014-03-22');
  // Andrea books 3 for Maya.
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001']), item(T.green, 1, S['1001']), item(T.gray, 2, S['1001'])] });
  assert.ok(r.body.results.every((x) => x.ok));
  // Both try to book the 4th at the same moment, with different teachers: exactly one wins.
  const [a, d] = await Promise.all([
    andrea.post('/api/parent/bookings', { items: [item(T.brown, 3, S['1001'])] }),
    david.post('/api/parent/bookings', { items: [item(T.white, 4, S['1001'])] }),
  ]);
  const oks = [a.body.results[0], d.body.results[0]];
  assert.equal(oks.filter((x) => x.ok).length, 1, JSON.stringify(oks));
  assert.equal(oks.find((x) => !x.ok).code, 'LIMIT_REACHED');
  // Now both try a 5th at the same moment: both refused.
  const [a5, d5] = await Promise.all([
    andrea.post('/api/parent/bookings', { items: [item(T.white, 6, S['1001'])] }),
    david.post('/api/parent/bookings', { items: [item(T.brown, 7, S['1001'])] }),
  ]);
  assert.equal(a5.body.results[0].ok, false);
  assert.equal(d5.body.results[0].ok, false);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE student_id = ? AND status = 'active'").get(S['1001']).n, 4);
  // David sees Andrea's bookings as "booked by another parent" and Maya's count as 4.
  const dov = (await david.get('/api/parent/overview')).body;
  assert.equal(dov.children[0].used, 4);
  assert.ok(dov.other_bookings.length >= 3);
  // Cleanup.
  for (const id of app.db.prepare("SELECT id, guardian_id FROM bookings WHERE status = 'active'").all()) {
    assert.equal((await admin.post(`/api/admin/bookings/${id.id}/cancel`, { reason: 'test cleanup' })).status, 200);
  }
});

test('separated parents may each meet the same teacher; both count toward the child', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const david = await app.parent('dthompson@example.com', '2014-03-22');
  const a = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] });
  const d = await david.post('/api/parent/bookings', { items: [item(T.rpatel, 1, S['1001'])] });
  assert.equal(a.body.results[0].ok, true);
  assert.equal(d.body.results[0].ok, true);
  assert.equal((await david.get('/api/parent/overview')).body.children[0].used, 2);
  for (const id of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${id.id}/cancel`, {});
});

test('same time with two teachers is blocked; back-to-back with different teachers is flagged', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 3, S['1001']), item(T.green, 3, S['1001'])] });
  assert.equal(r.body.results[0].ok, true);
  assert.equal(r.body.results[1].ok, false);
  assert.equal(r.body.results[1].code, 'TIME_CONFLICT');
  const opts = (await andrea.get(`/api/parent/teachers/${T.green}/slots`)).body.options;
  assert.equal(opts[3].status, 'conflict');
  assert.equal(opts[2].adjacent, true);
  assert.equal(opts[4].adjacent, true);
  assert.equal(opts[6].adjacent, false);
  // Back-to-back is a warning only: booking it works.
  const r2 = await andrea.post('/api/parent/bookings', { items: [item(T.green, 4, S['1001'])] });
  assert.equal(r2.body.results[0].ok, true);
  for (const id of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${id.id}/cancel`, {});
});

test('a co-taught booking reserves both teachers, and only mutually free times are offered', async () => {
  const linh = await app.parent('linh@example.com', '2014-05-05');
  const leeId = T.jlee;
  // Ms. Lee is busy at slot 0 (blocked by the office) and slot 1 (another student's meeting is simulated by a block too).
  const leeSlots = app.db.prepare('SELECT id, starts_at FROM slots WHERE teacher_id = ? ORDER BY starts_at').all(leeId);
  assert.equal((await admin.post(`/api/admin/slots/${leeSlots[0].id}/block`, { reason: 'IEP meeting' })).status, 200);
  const ov = (await linh.get('/api/parent/overview')).body;
  const green = ov.children[0].teachers.find((t) => t.teacher_id === T.green);
  assert.deepEqual(green.co_teachers.map((c) => c.name), ['Ms. Lee']);
  // Ms. Lee is not listed as a separate teacher for Ana.
  assert.equal(ov.children[0].teachers.some((t) => t.teacher_id === leeId), false);
  const opts = (await linh.get(`/api/parent/teachers/${T.green}/slots`)).body.options;
  assert.equal(opts[0].status, 'full');
  assert.equal(opts[1].status, 'open');
  const r = await linh.post('/api/parent/bookings', { items: [item(T.green, 0, S['1003'])] });
  assert.equal(r.body.results[0].code, 'SLOT_TAKEN');
  const ok = await linh.post('/api/parent/bookings', { items: [item(T.green, 1, S['1003'])] });
  assert.equal(ok.body.results[0].ok, true);
  // Both teachers' slots are now taken by the one booking, which counts once.
  const bs = app.db.prepare('SELECT teacher_id, role FROM booking_slots WHERE booking_id = ? ORDER BY role').all(ok.body.results[0].bookingId);
  assert.deepEqual(bs.map((x) => [x.teacher_id, x.role]), [[leeId, 'co'], [T.green, 'primary']].sort((a, b) => (a[1] < b[1] ? -1 : 1)));
  assert.equal((await linh.get('/api/parent/overview')).body.children[0].used, 1);
  // It shows on both teachers' schedules, each naming the other.
  const lee = await app.staff('jlee@school.org');
  const ls = (await lee.get('/api/teacher/schedule')).body.slots.find((s) => s.booking);
  assert.deepEqual(ls.booking.co_teachers, ['Ms. Green']);
  assert.equal(ls.booking.can_change, false);
  const greenC = await app.staff('green@school.org');
  const gs = (await greenC.get('/api/teacher/schedule')).body.slots.find((s) => s.booking);
  assert.deepEqual(gs.booking.co_teachers, ['Ms. Lee']);
  // Another family that needs only Ms. Green can still use slot 0 (Ms. Lee's block doesn't affect them).
  const chidi = await app.parent('chidi@example.com', '2015-01-10');
  const c0 = await chidi.post('/api/parent/bookings', { items: [item(T.green, 0, S['1005'])] });
  assert.equal(c0.body.results[0].ok, true);
  // ...but not slot 1, which the co-taught meeting holds.
  const c1 = await chidi.post('/api/parent/bookings', { items: [item(T.green, 1, S['1005'])] });
  assert.equal(c1.body.results[0].ok, false);
  await admin.post(`/api/admin/slots/${leeSlots[0].id}/unblock`, {});
  for (const id of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${id.id}/cancel`, {});
});

test('a full teacher offers "tried to book", which both co-teachers see; the teacher can mark it handled', async () => {
  // Fill every Ms. Green slot except none: block them all via admin.
  const greenSlots = app.db.prepare('SELECT id FROM slots WHERE teacher_id = ?').all(T.green);
  for (const s of greenSlots) await admin.post(`/api/admin/slots/${s.id}/block`, { reason: 'full' });
  const linh = await app.parent('linh@example.com', '2014-05-05');
  const ov = (await linh.get('/api/parent/overview')).body;
  assert.equal(ov.children[0].teachers.find((t) => t.teacher_id === T.green).open_count, 0);
  const r = await linh.post('/api/parent/attempts', { teacher_id: T.green, student_id: S['1003'], note: 'Any time after 4pm works' });
  assert.equal(r.status, 200);
  for (const email of ['green@school.org', 'jlee@school.org']) {
    const c = await app.staff(email);
    const a = (await c.get('/api/teacher/schedule')).body.attempts;
    assert.equal(a.length, 1, email);
    assert.equal(a[0].note, 'Any time after 4pm works');
    assert.equal(a[0].student_name, 'Ana Nguyễn');
  }
  const green = await app.staff('green@school.org');
  const a = (await green.get('/api/teacher/schedule')).body.attempts[0];
  assert.equal((await green.post(`/api/teacher/attempts/${a.id}`, { status: 'contacted' })).status, 200);
  assert.equal((await green.get('/api/teacher/schedule')).body.attempts[0].status, 'contacted');
  // Another teacher cannot touch it.
  const patel = await app.staff('rpatel@school.org');
  assert.equal((await patel.post(`/api/teacher/attempts/${a.id}`, { status: 'scheduled' })).status, 409);
  for (const s of greenSlots) await admin.post(`/api/admin/slots/${s.id}/unblock`, {});
  assert.ok((await admin.get('/api/admin/dashboard')).body.teachers.find((t) => t.id === T.green).tried >= 1);
});

test('a teacher can add a parent manually; it counts toward the 4 and emails the parent', async () => {
  const patel = await app.staff('rpatel@school.org');
  const roster = (await patel.get('/api/teacher/roster')).body.students;
  const maria = roster.find((s) => s.first_name === 'José');
  assert.ok(maria);
  const before = app.db.prepare("SELECT COUNT(*) n FROM emails WHERE to_email = 'maria@example.com'").get().n;
  const r = await patel.post('/api/teacher/bookings', { starts_at: times[5], student_id: maria.id, guardian_id: maria.guardians[0].id, note: 'Added by teacher' });
  assert.equal(r.status, 200, r.text);
  const after = app.db.prepare("SELECT kind, subject, text_body FROM emails WHERE to_email = 'maria@example.com' ORDER BY id DESC LIMIT 1").get();
  assert.ok(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE to_email = 'maria@example.com'").get().n > before);
  assert.equal(after.kind, 'confirmation_booked');
  assert.match(after.text_body, /Mr\. Patel, Room 214/);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE student_id = ? AND status = 'active'").get(S['1007']).n, 1);
  // A teacher can't book a slot that is taken.
  const r2 = await patel.post('/api/teacher/bookings', { starts_at: times[5], student_id: S['1004'], guardian_id: app.guardianId('chidi@example.com') });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.code, 'SLOT_TAKEN');
  // Or book a student who isn't theirs.
  const r3 = await patel.post('/api/teacher/bookings', { starts_at: times[6], student_id: S['1006'], guardian_id: app.guardianId('chidi@example.com') });
  assert.equal(r3.status, 409);
  for (const id of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${id.id}/cancel`, {});
});

test('teachers can block times only before booking opens; booked times cannot be blocked', async () => {
  const patel = await app.staff('rpatel@school.org');
  const slot = (await patel.get('/api/teacher/schedule')).body.slots[0];
  const r = await patel.post(`/api/teacher/slots/${slot.id}/block`, { reason: 'Lunch' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /before booking opens/);
  // The office can block at any time, but not a booked slot.
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] });
  const r2 = await admin.post(`/api/admin/slots/${slot.id}/block`, { reason: 'x' });
  assert.equal(r2.status, 409);
  // Even a direct database write is refused.
  assert.throws(() => app.db.prepare("UPDATE slots SET status = 'blocked' WHERE id = ?").run(slot.id), /SLOT_BOOKED/);
  for (const id of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${id.id}/cancel`, {});
});

test('a parent can change a booking to another time atomically', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] });
  const id = r.body.results[0].bookingId;
  // Moving onto a taken slot fails and keeps the original.
  const chidi = await app.parent('chidi@example.com', '2015-01-10');
  await chidi.post('/api/parent/bookings', { items: [item(T.rpatel, 1, S['1004'])] });
  const bad = await andrea.post(`/api/parent/bookings/${id}/move`, { starts_at: times[1] });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'SLOT_TAKEN');
  assert.ok(Array.isArray(bad.body.alternatives) && bad.body.alternatives.length > 0);
  assert.equal(app.db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'active');
  const good = await andrea.post(`/api/parent/bookings/${id}/move`, { starts_at: times[2] });
  assert.equal(good.status, 200, good.text);
  const ov = (await andrea.get('/api/parent/overview')).body;
  assert.equal(ov.bookings.length, 1);
  assert.equal(ov.bookings[0].starts_at, times[2]);
  assert.equal(ov.children.find((c) => c.first_name === 'Maya').used, 1);
  const mail = app.db.prepare("SELECT kind, text_body FROM emails WHERE to_email = 'aruiz@example.com' ORDER BY id DESC LIMIT 1").get();
  assert.equal(mail.kind, 'confirmation_changed');
  assert.match(mail.text_body, /moved from/);
  // The old slot is free again.
  const opts = (await andrea.get(`/api/parent/teachers/${T.rpatel}/slots`)).body.options;
  assert.equal(opts[0].status, 'open');
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('a parent cannot see, cancel or change another family\'s bookings', async () => {
  const chidi = await app.parent('chidi@example.com', '2015-01-10');
  const r = await chidi.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1004'])] });
  const id = r.body.results[0].bookingId;
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  assert.equal((await andrea.post(`/api/parent/bookings/${id}/cancel`)).status, 409);
  assert.equal((await andrea.post(`/api/parent/bookings/${id}/move`, { starts_at: times[4] })).status, 409);
  const ov = (await andrea.get('/api/parent/overview')).body;
  assert.ok(!JSON.stringify(ov).includes('Okafor'));
  // Slot lists show "full" without naming anyone.
  const opts = (await andrea.get(`/api/parent/teachers/${T.rpatel}/slots`)).body;
  assert.equal(opts.options[0].status, 'full');
  assert.ok(!JSON.stringify(opts).includes('Okafor'));
  // A teacher the family doesn't have is not visible.
  assert.equal((await andrea.get(`/api/parent/teachers/${T.jlee}/slots`)).status, 404);
  // Booking a teacher who doesn't teach the child is refused.
  const x = await andrea.post('/api/parent/bookings', { items: [item(T.kim, 3, S['1001'])] });
  assert.equal(x.body.results[0].code, 'NOT_ALLOWED');
  // Booking for someone else's child is refused.
  const y = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 3, S['1004'])] });
  assert.equal(y.body.results[0].ok, false);
  await admin.post(`/api/admin/bookings/${id}/cancel`, {});
});

test('admin can raise one child\'s limit above 4', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const four = [item(T.rpatel, 0, S['1001']), item(T.green, 1, S['1001']), item(T.gray, 2, S['1001']), item(T.brown, 3, S['1001'])];
  assert.ok((await andrea.post('/api/parent/bookings', { items: four })).body.results.every((x) => x.ok));
  assert.equal((await andrea.post('/api/parent/bookings', { items: [item(T.white, 4, S['1001'])] })).body.results[0].code, 'LIMIT_REACHED');
  assert.equal((await admin.post('/api/admin/limits', { student_id: S['1001'], max: 5 })).status, 200);
  assert.equal((await andrea.post('/api/parent/bookings', { items: [item(T.white, 4, S['1001'])] })).body.results[0].ok, true);
  await admin.post('/api/admin/limits', { student_id: S['1001'], max: null });
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('the database itself refuses double bookings and over-limit inserts, even bypassing the app', async () => {
  const db = app.db;
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] });
  const slot = db.prepare('SELECT slot_id FROM booking_slots WHERE booking_id = ?').get(r.body.results[0].bookingId).slot_id;
  const ev = db.prepare('SELECT id FROM events WHERE is_current = 1').get().id;
  const now = new Date().toISOString();
  const g = app.guardianId('chidi@example.com');
  const bid = db.prepare(`INSERT INTO bookings (event_id, teacher_id, student_id, guardian_id, starts_at, ends_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`).run(ev, T.rpatel, S['1004'], g, times[0], times[1], now).lastInsertRowid;
  assert.throws(() => db.prepare("INSERT INTO booking_slots (slot_id, booking_id, teacher_id, role) VALUES (?, ?, ?, 'primary')").run(slot, bid, T.rpatel), /UNIQUE constraint failed: booking_slots.slot_id/);
  db.prepare('DELETE FROM bookings WHERE id = ?').run(bid);
  // Over the limit, straight into the table.
  db.prepare('UPDATE events SET max_per_child = 1 WHERE id = ?').run(ev);
  assert.throws(() => db.prepare(`INSERT INTO bookings (event_id, teacher_id, student_id, guardian_id, starts_at, ends_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`).run(ev, T.green, S['1001'], app.guardianId('dthompson@example.com'), times[5], times[6], now), /LIMIT_REACHED/);
  db.prepare('UPDATE events SET max_per_child = 4 WHERE id = ?').run(ev);
  // A parent in two places at once, straight into the table.
  assert.throws(() => db.prepare(`INSERT INTO bookings (event_id, teacher_id, student_id, guardian_id, starts_at, ends_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'test', ?)`).run(ev, T.green, S['1002'], app.guardianId('aruiz@example.com'), times[0], times[1], now), /TIME_CONFLICT/);
  // A cancelled booking can never come back to life.
  await admin.post(`/api/admin/bookings/${r.body.results[0].bookingId}/cancel`, {});
  assert.throws(() => db.prepare("UPDATE bookings SET status = 'active' WHERE id = ?").run(r.body.results[0].bookingId), /BOOKING_IMMUTABLE/);
});

test('booking is refused before it opens and after it closes; staff can still add', async () => {
  const ev = app.db.prepare('SELECT id, booking_opens_at, booking_closes_at FROM events WHERE is_current = 1').get();
  app.db.prepare('UPDATE events SET booking_opens_at = ? WHERE id = ?').run(new Date(Date.now() + 3600e3).toISOString(), ev.id);
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  assert.equal((await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] })).body.results[0].code, 'NOT_OPEN');
  app.db.prepare('UPDATE events SET booking_opens_at = ?, booking_closes_at = ? WHERE id = ?').run(new Date(Date.now() - 7200e3).toISOString(), new Date(Date.now() - 3600e3).toISOString(), ev.id);
  assert.equal((await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] })).body.results[0].code, 'CLOSED');
  const r = await admin.post('/api/admin/bookings', { teacher_id: T.rpatel, starts_at: times[0], student_id: S['1001'], guardian_id: app.guardianId('aruiz@example.com') });
  assert.equal(r.status, 200, r.text);
  app.db.prepare('UPDATE events SET booking_opens_at = ?, booking_closes_at = ? WHERE id = ?').run(ev.booking_opens_at, ev.booking_closes_at, ev.id);
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('inside the 6-hour cutoff, parents cannot cancel or change, but teachers and the office can', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001']), item(T.green, 2, S['1001'])] });
  const [b1, b2] = r.body.results.map((x) => x.bookingId);
  // Pretend the event is 5 hours away by raising the cutoff to cover now.
  const ev = app.db.prepare('SELECT id FROM events WHERE is_current = 1').get();
  app.db.prepare('UPDATE events SET cutoff_hours = ? WHERE id = ?').run(24 * 11, ev.id);
  const c = await andrea.post(`/api/parent/bookings/${b1}/cancel`);
  assert.equal(c.status, 409);
  assert.equal(c.body.code, 'LOCKED');
  const mv = await andrea.post(`/api/parent/bookings/${b1}/move`, { starts_at: times[4] });
  assert.equal(mv.body.code, 'LOCKED');
  const ov = (await andrea.get('/api/parent/overview')).body;
  assert.equal(ov.event.parent_changes_locked, true);
  // The teacher can move their own booking; the office can cancel.
  const patel = await app.staff('rpatel@school.org');
  assert.equal((await patel.post(`/api/teacher/bookings/${b1}/move`, { starts_at: times[4] })).status, 200);
  // But a teacher cannot cancel another teacher's conference.
  assert.equal((await patel.post(`/api/teacher/bookings/${b2}/cancel`, {})).status, 409);
  assert.equal((await admin.post(`/api/admin/bookings/${b2}/cancel`, { reason: 'Office change' })).status, 200);
  const mail = app.db.prepare("SELECT kind, text_body FROM emails WHERE to_email = 'aruiz@example.com' ORDER BY id DESC LIMIT 1").get();
  assert.equal(mail.kind, 'slot_cancelled');
  assert.match(mail.text_body, /cancelled by the school \(Office change\)/);
  app.db.prepare('UPDATE events SET cutoff_hours = 6 WHERE id = ?').run(ev.id);
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('twins with the same date of birth both show up', async () => {
  const chidi = await app.parent('chidi@example.com', '2015-01-10');
  const ov = (await chidi.get('/api/parent/overview')).body;
  assert.deepEqual(ov.children.map((c) => c.first_name), ['Alex', 'Jamie', 'Sam']);
});

test('the parent with 3 children sees every teacher across all of them', async () => {
  const chidi = await app.parent('chidi@example.com', '2017-02-02');
  const ov = (await chidi.get('/api/parent/overview')).body;
  const map = Object.fromEntries(ov.children.map((c) => [c.first_name, c.teachers.map((t) => t.name)]));
  assert.deepEqual(map, { Alex: ['Ms. Green'], Jamie: ['Ms. Fox'], Sam: ['Mr. Patel'] });
});

test('event setup validates input and refuses impossible times', async () => {
  const bad = await admin.post('/api/admin/event', eventInput({ slot_minutes: 3, days: [{ day: '2026-02-30', start_time: '15:00', end_time: '14:00' }], booking_opens_at: 'soon' }));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.length >= 3, JSON.stringify(bad.body.errors));
  const dst = await admin.post('/api/admin/event', eventInput({ days: [{ day: '2027-03-14', start_time: '02:00', end_time: '04:00' }], booking_closes_at: '2027-03-13T12:00' }));
  assert.equal(dst.status, 400);
  assert.match(dst.body.error, /does not exist/);
  // Changing slot length is refused while bookings exist.
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 0, S['1001'])] });
  const ch = await admin.post('/api/admin/event', eventInput({ slot_minutes: 15 }));
  assert.equal(ch.status, 400);
  assert.match(ch.body.error, /slot length/);
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('extending event hours adds slots; shrinking keeps booked ones and flags them', async () => {
  const andrea = await app.parent('aruiz@example.com', '2014-03-22');
  const r = await andrea.post('/api/parent/bookings', { items: [item(T.rpatel, 11, S['1001'])] });
  assert.equal(r.body.results[0].ok, true);
  const day = localDay(10);
  const ok = await admin.post('/api/admin/event', eventInput({ days: [{ day, start_time: '15:00', end_time: '16:00' }] }));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.slots.strandedBookings.length, 1);
  const dash = (await admin.get('/api/admin/dashboard')).body;
  assert.equal(dash.stranded.length, 1);
  assert.equal(dash.stranded[0].reason, 'Time is outside the event hours');
  // Only the booked late slot survives outside the new hours.
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM slots WHERE teacher_id = ?').get(T.rpatel).n, 7);
  const back = await admin.post('/api/admin/event', eventInput({ days: [{ day, start_time: '15:00', end_time: '17:00' }] }));
  assert.equal(back.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM slots WHERE teacher_id = ?').get(T.rpatel).n, 12);
  assert.equal((await admin.get('/api/admin/dashboard')).body.stranded.length, 0);
  for (const b of app.db.prepare("SELECT id FROM bookings WHERE status = 'active'").all()) await admin.post(`/api/admin/bookings/${b.id}/cancel`, {});
});

test('multi-day events work and slots follow the school time zone', async () => {
  const d1 = localDay(10);
  const d2 = localDay(11);
  const r = await admin.post('/api/admin/event', eventInput({ days: [{ day: d2, start_time: '17:00', end_time: '18:00' }, { day: d1, start_time: '15:00', end_time: '17:00' }] }));
  assert.equal(r.status, 200, r.text);
  const tz = require('../src/tz');
  const s = app.db.prepare('SELECT starts_at FROM slots WHERE teacher_id = ? ORDER BY starts_at').all(T.rpatel).map((x) => x.starts_at);
  assert.equal(s.length, 18);
  assert.equal(tz.localHM(s[0]), '15:00');
  assert.equal(tz.localDate(s[12]), d2);
  assert.equal(tz.localHM(s[12]), '17:00');
  const back = await admin.post('/api/admin/event', eventInput());
  assert.equal(back.status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM slots WHERE teacher_id = ?').get(T.rpatel).n, 12);
  assert.equal(localInput(0).length, 16);
});
