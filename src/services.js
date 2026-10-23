'use strict';
// Read models for each screen, and actions that combine a booking change with
// the emails it triggers.

const { tx, audit, nowIso } = require('./db');
const { bookingState, parentChangesLocked } = require('./events');
const roster = require('./roster');
const booking = require('./booking');
const email = require('./email');
const config = require('./config');

function eventSummary(ev) {
  if (!ev) return null;
  return {
    id: ev.id, name: ev.name, days: ev.days, slot_minutes: ev.slot_minutes,
    booking_opens_at: ev.booking_opens_at, booking_closes_at: ev.booking_closes_at,
    starts_at: ev.starts_at, ends_at: ev.ends_at, change_cutoff_at: ev.change_cutoff_at,
    cutoff_hours: ev.cutoff_hours, max_per_child: ev.max_per_child, location_note: ev.location_note,
    state: bookingState(ev), parent_changes_locked: parentChangesLocked(ev),
  };
}

function studentNames(db, bookingId) {
  return db.prepare(`SELECT s.id, s.first_name, s.last_name FROM booking_students bs JOIN students s ON s.id = bs.student_id
    WHERE bs.booking_id = ? ORDER BY s.first_name`).all(bookingId);
}

function coTeacherNames(db, bookingId) {
  return db.prepare(`SELECT t.id, t.name, t.room FROM booking_slots bs JOIN teachers t ON t.id = bs.teacher_id
    WHERE bs.booking_id = ? AND bs.role = 'co' ORDER BY t.name`).all(bookingId);
}

// ---------- parent ----------

function parentOverview(db, ev, guardianId) {
  const children = roster.childrenOfGuardian(db, guardianId);
  const teacherQ = db.prepare('SELECT id, name, room FROM teachers WHERE id = ?');
  const myBookings = ev ? db.prepare(`SELECT b.*, t.name teacher_name, t.room FROM bookings b JOIN teachers t ON t.id = b.teacher_id
    WHERE b.event_id = ? AND b.guardian_id = ? AND b.status = 'active' ORDER BY b.starts_at`).all(ev.id, guardianId) : [];
  const byTeacher = new Map(myBookings.map((b) => [b.teacher_id, b]));
  const attempts = ev ? new Set(db.prepare("SELECT teacher_id FROM attempts WHERE event_id = ? AND guardian_id = ? AND status = 'new'").all(ev.id, guardianId).map((r) => r.teacher_id)) : new Set();
  const childName = new Map(children.map((c) => [c.id, c.first_name]));
  const meetingCache = new Map();
  const out = children.map((c) => {
    const links = roster.teacherLinksForStudent(db, c.id);
    const teachers = [];
    for (const [tid, l] of links) {
      const t = teacherQ.get(tid);
      if (!meetingCache.has(tid)) {
        const opts = ev ? booking.slotOptions(db, ev.id, guardianId, tid) : { options: [], coTeachers: [], covered: [] };
        meetingCache.set(tid, opts);
      }
      const m = meetingCache.get(tid);
      const b = byTeacher.get(tid);
      teachers.push({
        teacher_id: tid, name: t.name, room: t.room, sections: [...l.sections].sort(),
        co_teachers: m.coTeachers.map((x) => ({ id: x.id, name: x.name, room: x.room })),
        shared_with: m.covered.filter((id) => id !== c.id).map((id) => childName.get(id)),
        covered_ids: m.covered,
        open_count: m.options.filter((o) => o.status === 'open').length,
        total_count: m.options.length,
        booking: b ? { id: b.id, starts_at: b.starts_at, ends_at: b.ends_at, counted_student_id: b.student_id, note: b.note } : null,
        waitlisted: attempts.has(tid),
      });
    }
    teachers.sort((a, b) => a.name.localeCompare(b.name));
    return {
      id: c.id, first_name: c.first_name, last_name: c.last_name,
      used: ev ? booking.childUsed(db, ev.id, c.id) : 0,
      limit: ev ? booking.childLimit(db, ev.id, c.id) : 0,
      teachers,
    };
  });
  // Conferences another guardian booked for the same children (they count toward the same limit).
  const others = ev && children.length ? db.prepare(`SELECT b.id, b.starts_at, b.ends_at, b.student_id, t.name teacher_name, t.room, g.name guardian_name
    FROM bookings b JOIN teachers t ON t.id = b.teacher_id JOIN guardians g ON g.id = b.guardian_id
    WHERE b.event_id = ? AND b.status = 'active' AND b.guardian_id <> ? AND b.student_id IN (${children.map(() => '?').join(',')})
    ORDER BY b.starts_at`).all(ev.id, guardianId, ...children.map((c) => c.id)) : [];
  return {
    event: eventSummary(ev),
    children: out,
    bookings: myBookings.map((b) => ({
      id: b.id, teacher_id: b.teacher_id, teacher_name: b.teacher_name, room: b.room, starts_at: b.starts_at, ends_at: b.ends_at,
      note: b.note, counted_student_id: b.student_id, students: studentNames(db, b.id), co_teachers: coTeacherNames(db, b.id),
    })),
    other_bookings: others.map((o) => ({ ...o, student_name: childName.get(o.student_id) })),
  };
}

function notifyBooked(db, ev, guardianId, reason, note) {
  try { email.sendFamilyConfirmation(db, ev, guardianId, reason, note); } catch (e) { console.error('confirmation email', e); }
}

// Books several conferences from the parent's review screen. Each one is its
// own transaction, so one taken slot does not undo the others.
function parentConfirm(db, ev, guardian, items) {
  const results = [];
  for (const it of items.slice(0, 50)) {
    const r = booking.book(db, {
      eventId: ev.id, guardianId: guardian.id, teacherId: Number(it.teacher_id), startsAt: String(it.starts_at),
      studentId: Number(it.student_id), note: it.note, actor: `parent:${guardian.email}`, role: 'parent',
    });
    results.push({ teacher_id: Number(it.teacher_id), starts_at: it.starts_at, ...r });
    if (r.ok) {
      // A parent who had asked to be told about this teacher just got a time.
      db.prepare("UPDATE attempts SET status = 'scheduled', updated_by = ?, updated_at = ? WHERE event_id = ? AND guardian_id = ? AND teacher_id = ? AND status = 'new'")
        .run(`parent:${guardian.email}`, nowIso(), ev.id, guardian.id, Number(it.teacher_id));
    }
  }
  if (results.some((r) => r.ok)) notifyBooked(db, ev, guardian.id, 'booked');
  return results;
}

function describe(db, b) {
  const t = db.prepare('SELECT name FROM teachers WHERE id = ?').get(b.teacher_id);
  const tzm = require('./tz');
  return { teacherName: t ? t.name : 'the teacher', when: `${tzm.fmtDate(b.starts_at)} at ${tzm.fmtTime(b.starts_at)}` };
}

function cancelAndNotify(db, ev, bookingId, who, reason = '') {
  const r = booking.cancel(db, bookingId, who, reason);
  if (!r.ok) return r;
  const b = r.booking;
  const d = describe(db, b);
  if (who.role === 'parent') notifyBooked(db, ev, b.guardian_id, 'cancelled', `You cancelled your ${d.when} conference with ${d.teacherName}.`);
  else {
    try { email.sendSlotCancelled(db, ev, b.guardian_id, b, d.teacherName, reason); } catch (e) { console.error('cancel email', e); }
  }
  return { ok: true };
}

function moveAndNotify(db, ev, bookingId, startsAt, who) {
  const r = booking.move(db, bookingId, startsAt, who);
  if (!r.ok) return r;
  const d = describe(db, r.previous);
  const tzm = require('./tz');
  notifyBooked(db, ev, r.previous.guardian_id, 'changed', `Your conference with ${d.teacherName} moved from ${d.when} to ${tzm.fmtDate(startsAt)} at ${tzm.fmtTime(startsAt)}.`);
  return { ok: true, bookingId: r.bookingId };
}

// ---------- teacher ----------

function teacherSchedule(db, ev, teacherId) {
  if (!ev) return { slots: [], attempts: [] };
  const slots = db.prepare(`SELECT s.id, s.starts_at, s.ends_at, s.status, s.block_reason, bs.booking_id, bs.role
    FROM slots s LEFT JOIN booking_slots bs ON bs.slot_id = s.id WHERE s.event_id = ? AND s.teacher_id = ? ORDER BY s.starts_at`).all(ev.id, teacherId);
  const bQ = db.prepare(`SELECT b.*, g.name guardian_name, g.email guardian_email, g.email_status, t.name teacher_name
    FROM bookings b JOIN guardians g ON g.id = b.guardian_id JOIN teachers t ON t.id = b.teacher_id WHERE b.id = ?`);
  const allQ = db.prepare(`SELECT t.name FROM booking_slots bs JOIN teachers t ON t.id = bs.teacher_id WHERE bs.booking_id = ? AND bs.teacher_id <> ? ORDER BY t.name`);
  const out = slots.map((s) => {
    const row = { id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.booking_id ? 'booked' : s.status, block_reason: s.block_reason, booking: null };
    if (s.booking_id) {
      const b = bQ.get(s.booking_id);
      const students = studentNames(db, b.id);
      row.booking = {
        id: b.id, role: s.role, students: students.map((x) => `${x.first_name} ${x.last_name}`),
        guardian_name: b.guardian_name, guardian_email: b.guardian_email, email_status: b.email_status, note: b.note,
        co_teachers: allQ.all(b.id, teacherId).map((x) => x.name), main_teacher: b.teacher_name,
        created_by: b.created_by, can_change: s.role === 'primary',
      };
    }
    return row;
  });
  return { slots: out, attempts: teacherAttempts(db, ev.id, teacherId) };
}

function teacherAttempts(db, eventId, teacherId) {
  return db.prepare(`SELECT a.id, a.note, a.created_at, a.status, a.updated_at, a.teacher_id, s.first_name || ' ' || s.last_name student_name, s.id student_id,
      g.name guardian_name, g.email guardian_email, g.id guardian_id, t.name main_teacher
    FROM attempts a JOIN attempt_teachers at ON at.attempt_id = a.id AND at.teacher_id = ?
    JOIN students s ON s.id = a.student_id JOIN guardians g ON g.id = a.guardian_id JOIN teachers t ON t.id = a.teacher_id
    WHERE a.event_id = ? ORDER BY CASE a.status WHEN 'new' THEN 0 ELSE 1 END, a.created_at`).all(teacherId, eventId);
}

function setSlotBlocked(db, ev, slotId, blocked, reason, who) {
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, ev.id);
    if (!s) return { ok: false, message: 'Slot not found.' };
    if (who.role === 'teacher') {
      if (s.teacher_id !== who.teacherId) return { ok: false, message: 'Slot not found.' };
      if (bookingState(ev) !== 'not_open') return { ok: false, message: 'Teachers can block times only before booking opens. Ask the office to block a time now.' };
    }
    if (db.prepare('SELECT 1 FROM booking_slots WHERE slot_id = ?').get(slotId)) return { ok: false, message: 'That time is booked. Cancel the conference first.' };
    db.prepare('UPDATE slots SET status = ?, block_reason = ? WHERE id = ?').run(blocked ? 'blocked' : 'open', blocked ? String(reason || '').slice(0, 100) : null, slotId);
    audit(db, who.actor, blocked ? 'slot.block' : 'slot.unblock', { slotId, teacherId: s.teacher_id, startsAt: s.starts_at, reason: reason || '' });
    return { ok: true };
  });
}

function setAttemptStatus(db, ev, attemptId, status, who) {
  if (!['new', 'contacted', 'scheduled'].includes(status)) return { ok: false, message: 'Unknown status.' };
  return tx(db, () => {
    const a = db.prepare('SELECT a.id FROM attempts a JOIN attempt_teachers at ON at.attempt_id = a.id WHERE a.id = ? AND a.event_id = ? AND (at.teacher_id = ? OR ?)')
      .get(attemptId, ev.id, who.teacherId || -1, who.role === 'admin' ? 1 : 0);
    if (!a) return { ok: false, message: 'Not found.' };
    db.prepare('UPDATE attempts SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(status, who.actor, nowIso(), attemptId);
    audit(db, who.actor, 'attempt.status', { attemptId, status });
    return { ok: true };
  });
}

// Manual add by a teacher or the office: same rules, same confirmation email,
// counts toward the child's limit. Skips the booking window and change cutoff.
function staffBook(db, ev, { teacherId, startsAt, studentId, guardianId, note }, who) {
  const r = booking.book(db, {
    eventId: ev.id, guardianId: Number(guardianId), teacherId: Number(teacherId), startsAt: String(startsAt),
    studentId: Number(studentId), note, actor: who.actor, role: who.role,
  });
  if (r.ok) {
    db.prepare("UPDATE attempts SET status = 'scheduled', updated_by = ?, updated_at = ? WHERE event_id = ? AND guardian_id = ? AND teacher_id = ? AND status <> 'scheduled'")
      .run(who.actor, nowIso(), ev.id, Number(guardianId), Number(teacherId));
    notifyBooked(db, ev, Number(guardianId), 'booked');
  }
  return r;
}

// ---------- admin ----------

function dashboard(db, ev) {
  if (!ev) return { event: null };
  const teachers = db.prepare(`SELECT t.id, t.name, t.email, t.room, t.active,
      SUM(CASE WHEN bs.slot_id IS NOT NULL THEN 1 ELSE 0 END) booked,
      SUM(CASE WHEN bs.slot_id IS NULL AND s.status = 'blocked' THEN 1 ELSE 0 END) blocked,
      SUM(CASE WHEN bs.slot_id IS NULL AND s.status = 'open' THEN 1 ELSE 0 END) open,
      COUNT(s.id) total
    FROM teachers t LEFT JOIN slots s ON s.teacher_id = t.id AND s.event_id = ?
    LEFT JOIN booking_slots bs ON bs.slot_id = s.id
    WHERE t.active = 1 OR s.id IS NOT NULL
    GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all(ev.id);
  const tried = new Map(db.prepare(`SELECT at.teacher_id, COUNT(*) n, SUM(CASE WHEN a.status = 'new' THEN 1 ELSE 0 END) open_n
    FROM attempts a JOIN attempt_teachers at ON at.attempt_id = a.id WHERE a.event_id = ? GROUP BY at.teacher_id`).all(ev.id).map((r) => [r.teacher_id, r]));
  for (const t of teachers) { const x = tried.get(t.id); t.tried = x ? x.n : 0; t.tried_open = x ? x.open_n : 0; }
  const unbooked = db.prepare(`SELECT g.id, g.name, g.email, g.email_status,
      GROUP_CONCAT(s.first_name || ' ' || s.last_name, ', ') children
    FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id AND s.active = 1
    WHERE g.active = 1 AND NOT EXISTS (
      SELECT 1 FROM bookings b JOIN student_guardians sg2 ON sg2.student_id = b.student_id
      WHERE b.event_id = ? AND b.status = 'active' AND sg2.guardian_id = g.id)
    GROUP BY g.id ORDER BY g.name COLLATE NOCASE`).all(ev.id);
  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM bookings WHERE event_id = ? AND status = 'active') bookings,
      (SELECT COUNT(*) FROM guardians WHERE active = 1) guardians,
      (SELECT COUNT(*) FROM students WHERE active = 1) students,
      (SELECT COUNT(*) FROM teachers WHERE active = 1) teachers`).get(ev.id);
  const emailStats = db.prepare('SELECT status, COUNT(*) n FROM emails GROUP BY status').all();
  const badEmails = db.prepare("SELECT id, name, email, email_status, email_status_detail FROM guardians WHERE email_status <> 'ok' AND active = 1 ORDER BY name").all();
  const stranded = strandedBookings(db, ev);
  return { event: eventSummary(ev), teachers, unbooked, counts, emailStats, badEmails, stranded, open_email_sent_at: ev.open_email_sent_at };
}

// Active bookings that need an admin's eye: the student or teacher left the
// upload, or the time is no longer inside the event hours.
function strandedBookings(db, ev) {
  const { slotStartsForDay } = require('./events');
  const valid = new Set();
  for (const d of ev.days) for (const x of slotStartsForDay(d, ev.slot_minutes)) valid.add(x.starts_at);
  const rows = db.prepare(`SELECT b.id, b.starts_at, b.ends_at, s.active s_active, t.active t_active, g.active g_active,
      t.name teacher_name, s.first_name || ' ' || s.last_name student_name, g.name guardian_name
    FROM bookings b JOIN teachers t ON t.id = b.teacher_id JOIN students s ON s.id = b.student_id JOIN guardians g ON g.id = b.guardian_id
    WHERE b.event_id = ? AND b.status = 'active' ORDER BY b.starts_at`).all(ev.id);
  const out = [];
  for (const r of rows) {
    let reason = null;
    if (!r.s_active) reason = 'Student is no longer in the upload';
    else if (!r.t_active) reason = 'Teacher is no longer in the upload';
    else if (!r.g_active) reason = 'Parent is no longer in the upload';
    else if (!valid.has(r.starts_at)) reason = 'Time is outside the event hours';
    if (reason) out.push({ id: r.id, starts_at: r.starts_at, teacher_name: r.teacher_name, student_name: r.student_name, guardian_name: r.guardian_name, reason });
  }
  return out;
}

function teacherUnavailable(db, ev, teacherId, reason, who) {
  const ids = db.prepare(`SELECT DISTINCT bs.booking_id FROM booking_slots bs JOIN slots s ON s.id = bs.slot_id
    WHERE s.event_id = ? AND bs.teacher_id = ?`).all(ev.id, teacherId).map((r) => r.booking_id);
  let cancelled = 0;
  for (const id of ids) {
    const r = cancelAndNotify(db, ev, id, { ...who, role: 'admin' }, reason || 'Teacher unavailable');
    if (r.ok) cancelled++;
  }
  const blocked = Number(db.prepare("UPDATE slots SET status = 'blocked', block_reason = ? WHERE event_id = ? AND teacher_id = ? AND status = 'open' AND id NOT IN (SELECT slot_id FROM booking_slots)")
    .run(String(reason || 'Unavailable').slice(0, 100), ev.id, teacherId).changes);
  audit(db, who.actor, 'teacher.unavailable', { teacherId, cancelled, blocked, reason: reason || '' });
  return { ok: true, cancelled, blocked };
}

function sendBookingOpenEmails(db, ev, who) {
  return tx(db, () => {
    const gs = db.prepare(`SELECT DISTINCT g.id, g.name, g.email FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id
      JOIN students s ON s.id = sg.student_id AND s.active = 1 WHERE g.active = 1`).all();
    for (const g of gs) email.sendBookingOpen(db, ev, g);
    db.prepare('UPDATE events SET open_email_sent_at = ? WHERE id = ?').run(nowIso(), ev.id);
    audit(db, who.actor, 'email.booking_open', { count: gs.length });
    return { ok: true, count: gs.length };
  });
}

function masterRows(db, ev) {
  const rows = db.prepare(`SELECT b.id, b.starts_at, b.ends_at, b.note, t.name teacher_name, t.email teacher_email, t.room,
      g.name guardian_name, g.email guardian_email, s.first_name || ' ' || s.last_name counted_student
    FROM bookings b JOIN teachers t ON t.id = b.teacher_id JOIN guardians g ON g.id = b.guardian_id JOIN students s ON s.id = b.student_id
    WHERE b.event_id = ? AND b.status = 'active' ORDER BY b.starts_at, t.name`).all(ev.id);
  for (const r of rows) {
    r.students = studentNames(db, r.id).map((x) => `${x.first_name} ${x.last_name}`).join('; ');
    r.co_teachers = coTeacherNames(db, r.id).map((x) => x.name).join('; ');
  }
  return rows;
}

module.exports = {
  eventSummary, parentOverview, parentConfirm, cancelAndNotify, moveAndNotify, teacherSchedule, teacherAttempts,
  setSlotBlocked, setAttemptStatus, staffBook, dashboard, teacherUnavailable, sendBookingOpenEmails, masterRows, strandedBookings,
  config,
};
