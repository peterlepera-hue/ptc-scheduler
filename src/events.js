'use strict';
// Conference events: setup, validation and slot generation.

const { tx, nowIso, audit } = require('./db');
const tz = require('./tz');

function getEvent(db, id) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!ev) return null;
  ev.days = db.prepare('SELECT day, start_time, end_time FROM event_days WHERE event_id = ? ORDER BY day').all(id);
  ev.reminder_times = JSON.parse(ev.reminder_times || '[]');
  ev.starts_at = ev.days.length ? tz.zonedToUtc(ev.days[0].day, ev.days[0].start_time).toISOString() : null;
  const last = ev.days[ev.days.length - 1];
  ev.ends_at = last ? tz.zonedToUtc(last.day, last.end_time).toISOString() : null;
  ev.change_cutoff_at = ev.starts_at ? new Date(Date.parse(ev.starts_at) - ev.cutoff_hours * 3600e3).toISOString() : null;
  return ev;
}

function currentEvent(db) {
  const r = db.prepare('SELECT id FROM events WHERE is_current = 1').get();
  return r ? getEvent(db, r.id) : null;
}

function bookingState(ev, now = new Date()) {
  const t = now.toISOString();
  if (t < ev.booking_opens_at) return 'not_open';
  if (t >= ev.booking_closes_at) return 'closed';
  return 'open';
}

function parentChangesLocked(ev, now = new Date()) {
  return now.toISOString() >= ev.change_cutoff_at;
}

function slotStartsForDay(day, slotMinutes) {
  const out = [];
  const start = tz.hmToMinutes(day.start_time);
  const end = tz.hmToMinutes(day.end_time);
  for (let m = start; m + slotMinutes <= end; m += slotMinutes) {
    let d;
    try { d = tz.zonedToUtc(day.day, tz.minutesToHM(m)); } catch { continue; } // skipped DST hour
    out.push({ starts_at: d.toISOString(), ends_at: new Date(d.getTime() + slotMinutes * 60e3).toISOString() });
  }
  return out;
}

// Makes the slot table match the event's days and the active teachers.
// Adds missing slots; removes open slots that are no longer inside the event.
// Booked slots are never removed (the database refuses), they are reported instead.
function ensureSlots(db, eventId) {
  return tx(db, () => {
    const ev = getEvent(db, eventId);
    const wanted = [];
    for (const day of ev.days) wanted.push(...slotStartsForDay(day, ev.slot_minutes));
    const wantedSet = new Set(wanted.map((w) => w.starts_at));
    const teachers = db.prepare('SELECT id FROM teachers WHERE active = 1').all();
    const ins = db.prepare('INSERT OR IGNORE INTO slots (event_id, teacher_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, \'open\')');
    let added = 0;
    for (const t of teachers) for (const w of wanted) added += Number(ins.run(eventId, t.id, w.starts_at, w.ends_at).changes);
    const activeIds = new Set(teachers.map((t) => t.id));
    const existing = db.prepare(`SELECT s.id, s.teacher_id, s.starts_at, s.ends_at, bs.booking_id FROM slots s
      LEFT JOIN booking_slots bs ON bs.slot_id = s.id WHERE s.event_id = ?`).all(eventId);
    const del = db.prepare('DELETE FROM slots WHERE id = ?');
    let removed = 0;
    const strandedBookings = new Set();
    for (const s of existing) {
      const ok = wantedSet.has(s.starts_at) && activeIds.has(s.teacher_id)
        && Date.parse(s.ends_at) - Date.parse(s.starts_at) === ev.slot_minutes * 60e3;
      if (ok) continue;
      if (s.booking_id) { strandedBookings.add(s.booking_id); continue; }
      del.run(s.id);
      removed++;
    }
    return { added, removed, strandedBookings: [...strandedBookings] };
  });
}

function parseEventInput(input) {
  const errors = [];
  const name = String(input.name || '').trim();
  if (!name) errors.push('Event name is required.');
  const slotMinutes = Number(input.slot_minutes);
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 60) errors.push('Slot length must be a whole number of minutes between 5 and 60.');
  const days = [];
  const seen = new Set();
  for (const d of Array.isArray(input.days) ? input.days : []) {
    const day = String(d.day || '').trim();
    const start = String(d.start_time || '').trim();
    const end = String(d.end_time || '').trim();
    if (!tz.isValidYMD(day)) { errors.push(`Conference date "${day}" is not valid.`); continue; }
    if (seen.has(day)) { errors.push(`${day} is listed twice.`); continue; }
    seen.add(day);
    if (!tz.isValidHM(start) || !tz.isValidHM(end)) { errors.push(`Start and end times for ${day} must be HH:MM.`); continue; }
    if (tz.hmToMinutes(end) <= tz.hmToMinutes(start)) { errors.push(`End time must be after start time on ${day}.`); continue; }
    if (Number.isInteger(slotMinutes) && slotMinutes >= 5 && tz.hmToMinutes(end) - tz.hmToMinutes(start) < slotMinutes) errors.push(`${day} is shorter than one slot.`);
    try { tz.zonedToUtc(day, start); tz.zonedToUtc(day, end); } catch (e) { errors.push(e.message); continue; }
    days.push({ day, start_time: start, end_time: end });
  }
  if (days.length === 0 && !errors.some((e) => /date/.test(e))) errors.push('Add at least one conference date.');
  days.sort((a, b) => a.day.localeCompare(b.day));
  let opens = null;
  let closes = null;
  try { opens = tz.localInputToIso(input.booking_opens_at); } catch (e) { errors.push(`Booking opens: ${e.message}`); }
  try { closes = tz.localInputToIso(input.booking_closes_at); } catch (e) { errors.push(`Booking closes: ${e.message}`); }
  if (opens && closes && closes <= opens) errors.push('Booking must close after it opens.');
  if (closes && days.length) {
    const lastEnd = tz.zonedToUtc(days[days.length - 1].day, days[days.length - 1].end_time).toISOString();
    if (closes > lastEnd) errors.push('Booking must close before the last conference ends.');
  }
  const cutoff = Number(input.cutoff_hours ?? 6);
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 24 * 30) errors.push('Change/cancel cutoff must be between 0 and 720 hours.');
  const maxPer = Number(input.max_per_child ?? 4);
  if (!Number.isInteger(maxPer) || maxPer < 1 || maxPer > 50) errors.push('Max conferences per child must be a whole number from 1 to 50.');
  const reminders = [];
  for (const r of Array.isArray(input.reminder_times) ? input.reminder_times : []) {
    if (!String(r || '').trim()) continue;
    try { reminders.push(tz.localInputToIso(r)); } catch (e) { errors.push(`Reminder: ${e.message}`); }
  }
  reminders.sort();
  return {
    errors,
    value: {
      name, slot_minutes: slotMinutes, days, booking_opens_at: opens, booking_closes_at: closes,
      cutoff_hours: cutoff, max_per_child: maxPer, reminder_times: [...new Set(reminders)],
      location_note: String(input.location_note || '').trim().slice(0, 1000),
    },
  };
}

// Default reminders: 2 days before at 9am, and 7am on each conference day.
function defaultReminders(days) {
  if (!days.length) return [];
  const first = days[0].day;
  const d = new Date(`${first}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 2);
  const twoBefore = d.toISOString().slice(0, 10);
  return [`${twoBefore}T09:00`, ...days.map((x) => `${x.day}T07:00`)];
}

function saveEvent(db, input, actor, eventId = null) {
  const { errors, value } = parseEventInput(input);
  if (errors.length) return { errors };
  return tx(db, () => {
    let id = eventId;
    if (id) {
      const old = getEvent(db, id);
      if (!old) return { errors: ['Event not found.'] };
      const booked = db.prepare("SELECT COUNT(*) n FROM bookings WHERE event_id = ? AND status = 'active'").get(id).n;
      if (booked && old.slot_minutes !== value.slot_minutes) {
        return { errors: [`There are ${booked} active bookings, so the slot length can't change. Cancel them first or create a new event.`] };
      }
      db.prepare(`UPDATE events SET name = ?, slot_minutes = ?, booking_opens_at = ?, booking_closes_at = ?, cutoff_hours = ?,
        max_per_child = ?, reminder_times = ?, location_note = ? WHERE id = ?`).run(
        value.name, value.slot_minutes, value.booking_opens_at, value.booking_closes_at, value.cutoff_hours,
        value.max_per_child, JSON.stringify(value.reminder_times), value.location_note, id);
      db.prepare('DELETE FROM event_days WHERE event_id = ?').run(id);
    } else {
      db.prepare('UPDATE events SET is_current = 0').run();
      id = Number(db.prepare(`INSERT INTO events (name, slot_minutes, booking_opens_at, booking_closes_at, cutoff_hours, max_per_child,
        reminder_times, location_note, is_current, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
        value.name, value.slot_minutes, value.booking_opens_at, value.booking_closes_at, value.cutoff_hours, value.max_per_child,
        JSON.stringify(value.reminder_times), value.location_note, nowIso()).lastInsertRowid);
    }
    const insDay = db.prepare('INSERT INTO event_days (event_id, day, start_time, end_time) VALUES (?, ?, ?, ?)');
    for (const d of value.days) insDay.run(id, d.day, d.start_time, d.end_time);
    const slots = ensureSlots(db, id);
    audit(db, actor, eventId ? 'event.update' : 'event.create', { eventId: id, ...value });
    return { id, slots };
  });
}

module.exports = { getEvent, currentEvent, bookingState, parentChangesLocked, ensureSlots, saveEvent, parseEventInput, defaultReminders, slotStartsForDay };
