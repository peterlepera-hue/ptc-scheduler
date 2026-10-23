'use strict';
// The booking engine. Every write runs in one BEGIN IMMEDIATE transaction and
// re-checks every rule; the database triggers and unique keys in db.js back
// each rule up, so a race or an application bug still cannot double book.

const { tx, nowIso, audit } = require('./db');
const { getEvent, bookingState, parentChangesLocked } = require('./events');
const { meetingFor, teacherInfo } = require('./roster');

class BookingError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const MESSAGES = {
  SLOT_TAKEN: 'Sorry, that time was just taken.',
  LIMIT_REACHED: 'This child already has the maximum number of conferences.',
  TIME_CONFLICT: 'You already have a conference at that time.',
  ALREADY_BOOKED: 'You already have a conference with this teacher.',
  NOT_OPEN: 'Booking has not opened yet.',
  CLOSED: 'Booking is closed. Please contact the office to make changes.',
  LOCKED: 'It is too close to the conferences to change online. Please contact the office or the teacher.',
  NOT_ALLOWED: 'That conference is not available to you.',
  NOT_FOUND: 'That conference could not be found.',
};

function mapDbError(e) {
  if (e instanceof BookingError) return e;
  const m = String(e && e.message);
  if (/UNIQUE constraint failed: booking_slots\.slot_id|SLOT_UNAVAILABLE/.test(m)) return new BookingError('SLOT_TAKEN', MESSAGES.SLOT_TAKEN);
  if (/LIMIT_REACHED/.test(m)) return new BookingError('LIMIT_REACHED', MESSAGES.LIMIT_REACHED);
  if (/TIME_CONFLICT/.test(m)) return new BookingError('TIME_CONFLICT', MESSAGES.TIME_CONFLICT);
  if (/UNIQUE constraint failed: bookings\./.test(m)) return new BookingError('ALREADY_BOOKED', MESSAGES.ALREADY_BOOKED);
  return null;
}

function childLimit(db, eventId, studentId) {
  const o = db.prepare('SELECT max_conferences FROM child_limits WHERE event_id = ? AND student_id = ?').get(eventId, studentId);
  if (o) return o.max_conferences;
  return db.prepare('SELECT max_per_child FROM events WHERE id = ?').get(eventId).max_per_child;
}

function childUsed(db, eventId, studentId) {
  return db.prepare("SELECT COUNT(*) n FROM bookings WHERE event_id = ? AND student_id = ? AND status = 'active'").get(eventId, studentId).n;
}

function slotRow(db, eventId, teacherId, startsAt) {
  return db.prepare(`SELECT s.*, bs.booking_id FROM slots s LEFT JOIN booking_slots bs ON bs.slot_id = s.id
    WHERE s.event_id = ? AND s.teacher_id = ? AND s.starts_at = ?`).get(eventId, teacherId, startsAt);
}

// Every time the guardian could meet this teacher (plus any co-teacher),
// with each time marked open, full or conflicting with their own bookings.
function slotOptions(db, eventId, guardianId, teacherId, { ignoreBookingId = null } = {}) {
  const meeting = meetingFor(db, guardianId, teacherId);
  const teacherIds = [teacherId, ...meeting.coTeachers];
  const rows = db.prepare(`SELECT s.teacher_id, s.starts_at, s.ends_at, s.status, bs.booking_id FROM slots s
    LEFT JOIN booking_slots bs ON bs.slot_id = s.id
    WHERE s.event_id = ? AND s.teacher_id IN (${teacherIds.map(() => '?').join(',')}) ORDER BY s.starts_at`).all(eventId, ...teacherIds);
  const byStart = new Map();
  for (const r of rows) {
    if (!byStart.has(r.starts_at)) byStart.set(r.starts_at, { starts_at: r.starts_at, ends_at: r.ends_at, parts: new Map() });
    byStart.get(r.starts_at).parts.set(r.teacher_id, r);
  }
  const mine = db.prepare(`SELECT id, teacher_id, starts_at, ends_at FROM bookings
    WHERE event_id = ? AND guardian_id = ? AND status = 'active'`).all(eventId, guardianId).filter((b) => b.id !== ignoreBookingId);
  const out = [];
  for (const o of byStart.values()) {
    let free = true;
    for (const tid of teacherIds) {
      const p = o.parts.get(tid);
      if (!p || p.status !== 'open' || (p.booking_id && p.booking_id !== ignoreBookingId)) { free = false; break; }
    }
    // A slot that belongs to the booking being changed is "current", not free or full.
    const current = ignoreBookingId && teacherIds.every((tid) => o.parts.get(tid)?.booking_id === ignoreBookingId);
    const clash = mine.find((b) => b.starts_at < o.ends_at && o.starts_at < b.ends_at);
    const adjacent = mine.some((b) => b.teacher_id !== teacherId && (b.ends_at === o.starts_at || b.starts_at === o.ends_at));
    out.push({
      starts_at: o.starts_at,
      ends_at: o.ends_at,
      status: current ? 'current' : !free ? 'full' : clash ? 'conflict' : 'open',
      adjacent: free && !clash ? adjacent : false,
    });
  }
  return { options: out, coTeachers: teacherInfo(db, meeting.coTeachers), covered: meeting.covered };
}

function nextOpenTimes(db, eventId, guardianId, teacherId, after, n = 3) {
  return slotOptions(db, eventId, guardianId, teacherId).options
    .filter((o) => o.status === 'open' && o.starts_at >= (after || ''))
    .slice(0, n)
    .map((o) => ({ starts_at: o.starts_at, ends_at: o.ends_at }));
}

// Core insert. Must be called inside tx().
function insertBooking(db, { eventId, guardianId, teacherId, startsAt, studentId, note, actor, role }) {
  const ev = getEvent(db, eventId);
  if (!ev) throw new BookingError('NOT_FOUND', 'Event not found.');
  if (role === 'parent') {
    const state = bookingState(ev);
    if (state === 'not_open') throw new BookingError('NOT_OPEN', MESSAGES.NOT_OPEN);
    if (state === 'closed') throw new BookingError('CLOSED', MESSAGES.CLOSED);
  }
  const guardian = db.prepare('SELECT id, active FROM guardians WHERE id = ?').get(guardianId);
  if (!guardian || !guardian.active) throw new BookingError('NOT_ALLOWED', MESSAGES.NOT_ALLOWED);
  const teacher = db.prepare('SELECT id, active FROM teachers WHERE id = ?').get(teacherId);
  if (!teacher || !teacher.active) throw new BookingError('NOT_ALLOWED', MESSAGES.NOT_ALLOWED);
  const meeting = meetingFor(db, guardianId, teacherId);
  if (!meeting.covered.includes(studentId)) {
    throw new BookingError('NOT_ALLOWED', 'That teacher is not one of this child\'s teachers.');
  }
  const existing = db.prepare("SELECT id FROM bookings WHERE event_id = ? AND guardian_id = ? AND teacher_id = ? AND status = 'active'").get(eventId, guardianId, teacherId);
  if (existing) throw new BookingError('ALREADY_BOOKED', MESSAGES.ALREADY_BOOKED, { bookingId: existing.id });

  const teacherIds = [teacherId, ...meeting.coTeachers];
  const slots = [];
  for (const tid of teacherIds) {
    const s = slotRow(db, eventId, tid, startsAt);
    if (!s) throw new BookingError(tid === teacherId ? 'NOT_FOUND' : 'SLOT_TAKEN', tid === teacherId ? 'That time is not one of this teacher\'s conference times.' : MESSAGES.SLOT_TAKEN);
    if (s.status !== 'open' || s.booking_id) throw new BookingError('SLOT_TAKEN', MESSAGES.SLOT_TAKEN);
    slots.push(s);
  }
  const endsAt = slots[0].ends_at;
  const clash = db.prepare(`SELECT id FROM bookings WHERE event_id = ? AND guardian_id = ? AND status = 'active'
    AND starts_at < ? AND ? < ends_at`).get(eventId, guardianId, endsAt, startsAt);
  if (clash) throw new BookingError('TIME_CONFLICT', MESSAGES.TIME_CONFLICT);
  if (childUsed(db, eventId, studentId) >= childLimit(db, eventId, studentId)) {
    throw new BookingError('LIMIT_REACHED', MESSAGES.LIMIT_REACHED);
  }

  const id = Number(db.prepare(`INSERT INTO bookings (event_id, teacher_id, student_id, guardian_id, starts_at, ends_at, note, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(eventId, teacherId, studentId, guardianId, startsAt, endsAt,
    String(note || '').slice(0, 500), actor, nowIso()).lastInsertRowid);
  const insStu = db.prepare('INSERT INTO booking_students (booking_id, student_id) VALUES (?, ?)');
  for (const sid of meeting.covered) insStu.run(id, sid);
  const insSlot = db.prepare('INSERT INTO booking_slots (slot_id, booking_id, teacher_id, role) VALUES (?, ?, ?, ?)');
  for (const s of slots) insSlot.run(s.id, id, s.teacher_id, s.teacher_id === teacherId ? 'primary' : 'co');
  audit(db, actor, 'booking.create', { bookingId: id, eventId, teacherId, coTeachers: meeting.coTeachers, studentId, guardianId, startsAt, role });
  return id;
}

function wrap(db, fn, onSlotTaken) {
  try {
    return { ok: true, ...tx(db, fn) };
  } catch (e) {
    const be = mapDbError(e);
    if (!be) throw e;
    const out = { ok: false, code: be.code, message: be.message };
    if (be.code === 'SLOT_TAKEN' && onSlotTaken) out.alternatives = onSlotTaken();
    return out;
  }
}

function book(db, p) {
  return wrap(db, () => ({ bookingId: insertBooking(db, p) }),
    () => nextOpenTimes(db, p.eventId, p.guardianId, p.teacherId, p.startsAt));
}

function getBooking(db, id) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b) return null;
  b.slot_teacher_ids = db.prepare('SELECT teacher_id FROM booking_slots WHERE booking_id = ?').all(id).map((r) => r.teacher_id);
  b.student_ids = db.prepare('SELECT student_id FROM booking_students WHERE booking_id = ?').all(id).map((r) => r.student_id);
  return b;
}

// who: { role: 'parent'|'teacher'|'admin', actor, guardianId?, teacherId? }
function checkCanChange(db, b, who) {
  if (!b || b.status !== 'active') throw new BookingError('NOT_FOUND', MESSAGES.NOT_FOUND);
  if (who.role === 'parent') {
    if (b.guardian_id !== who.guardianId) throw new BookingError('NOT_FOUND', MESSAGES.NOT_FOUND);
    if (parentChangesLocked(getEvent(db, b.event_id))) throw new BookingError('LOCKED', MESSAGES.LOCKED);
  } else if (who.role === 'teacher') {
    if (b.teacher_id !== who.teacherId) throw new BookingError('NOT_ALLOWED', 'Only the main teacher for this conference (or the office) can change it.');
  } else if (who.role !== 'admin') {
    throw new BookingError('NOT_ALLOWED', MESSAGES.NOT_ALLOWED);
  }
}

function cancelInTx(db, bookingId, who, reason) {
  const b = getBooking(db, bookingId);
  checkCanChange(db, b, who);
  db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, cancel_reason = ? WHERE id = ?")
    .run(who.actor, nowIso(), String(reason || '').slice(0, 300), bookingId);
  db.prepare('DELETE FROM booking_slots WHERE booking_id = ?').run(bookingId);
  audit(db, who.actor, 'booking.cancel', { bookingId, role: who.role, reason: reason || '' });
  return b;
}

function cancel(db, bookingId, who, reason = '') {
  return wrap(db, () => ({ booking: cancelInTx(db, bookingId, who, reason) }));
}

// Moves a booking to another time with the same teacher, atomically: either the
// new time is booked and the old one released, or nothing changes.
function move(db, bookingId, newStartsAt, who) {
  return wrap(db, () => {
    const b = getBooking(db, bookingId);
    checkCanChange(db, b, who);
    if (b.starts_at === newStartsAt) throw new BookingError('NOT_ALLOWED', 'That is already the time of this conference.');
    cancelInTx(db, bookingId, who, 'Changed time');
    const id = insertBooking(db, {
      eventId: b.event_id, guardianId: b.guardian_id, teacherId: b.teacher_id, startsAt: newStartsAt,
      studentId: b.student_id, note: b.note, actor: who.actor, role: who.role,
    });
    audit(db, who.actor, 'booking.move', { from: bookingId, to: id, startsAt: newStartsAt });
    return { bookingId: id, previous: b };
  }, () => {
    const b = getBooking(db, bookingId);
    return b ? nextOpenTimes(db, b.event_id, b.guardian_id, b.teacher_id, newStartsAt) : [];
  });
}

function recordAttempt(db, { eventId, guardianId, teacherId, studentId, note, actor }) {
  return tx(db, () => {
    const meeting = meetingFor(db, guardianId, teacherId);
    if (!meeting.covered.includes(studentId)) throw new BookingError('NOT_ALLOWED', 'That teacher is not one of this child\'s teachers.');
    const dup = db.prepare("SELECT id FROM attempts WHERE event_id = ? AND guardian_id = ? AND teacher_id = ? AND status = 'new'").get(eventId, guardianId, teacherId);
    let id;
    if (dup) {
      id = dup.id;
      db.prepare('UPDATE attempts SET note = ?, created_at = ?, student_id = ? WHERE id = ?').run(String(note || '').slice(0, 500), nowIso(), studentId, id);
    } else {
      id = Number(db.prepare('INSERT INTO attempts (event_id, teacher_id, student_id, guardian_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(eventId, teacherId, studentId, guardianId, String(note || '').slice(0, 500), nowIso()).lastInsertRowid);
      const ins = db.prepare('INSERT OR IGNORE INTO attempt_teachers (attempt_id, teacher_id) VALUES (?, ?)');
      for (const t of [teacherId, ...meeting.coTeachers]) ins.run(id, t);
    }
    audit(db, actor, 'attempt.record', { attemptId: id, teacherId, studentId, guardianId });
    return { attemptId: id, updated: Boolean(dup) };
  });
}

module.exports = {
  BookingError, MESSAGES, book, cancel, move, slotOptions, nextOpenTimes, recordAttempt,
  childLimit, childUsed, getBooking, mapDbError,
};
