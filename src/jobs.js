'use strict';
// Timed jobs: the "you haven't booked" nudge, conference reminders and teacher
// summaries. Each job runs once (recorded in jobs_done), and a job that was due
// while the server was down still runs when it comes back, as long as the
// conferences have not ended.

const { tx, nowIso } = require('./db');
const { currentEvent } = require('./events');
const email = require('./email');
const services = require('./services');
const auth = require('./auth');
const tz = require('./tz');

function claim(db, key) {
  return Number(db.prepare('INSERT OR IGNORE INTO jobs_done (key, done_at) VALUES (?, ?)').run(key, nowIso()).changes) === 1;
}

function sendTeacherSummaries(db, ev) {
  const teachers = db.prepare('SELECT id, name, email, room FROM teachers WHERE active = 1').all();
  let n = 0;
  for (const t of teachers) {
    const sched = services.teacherSchedule(db, ev, t.id);
    if (!sched.slots.some((s) => s.booking) && !sched.attempts.length) continue;
    email.sendTeacherSummary(db, ev, t, sched.slots, sched.attempts);
    n++;
  }
  return n;
}

function runDue(db, now = new Date()) {
  const ev = currentEvent(db);
  if (!ev || !ev.ends_at) return [];
  const t = now.toISOString();
  const ran = [];
  if (t >= ev.ends_at) return ran;

  // Nudge families with no bookings, 2 days before booking closes.
  const nudgeAt = new Date(Date.parse(ev.booking_closes_at) - 48 * 3600e3).toISOString();
  if (t >= nudgeAt && t >= ev.booking_opens_at && t < ev.booking_closes_at) {
    tx(db, () => {
      if (!claim(db, `nudge:${ev.id}`)) return;
      const gs = db.prepare(`SELECT DISTINCT g.id, g.name, g.email FROM guardians g
        JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id AND s.active = 1
        WHERE g.active = 1 AND NOT EXISTS (
          SELECT 1 FROM bookings b JOIN student_guardians sg2 ON sg2.student_id = b.student_id
          WHERE b.event_id = ? AND b.status = 'active' AND sg2.guardian_id = g.id)`).all(ev.id);
      for (const g of gs) email.sendBookingNudge(db, ev, g);
      ran.push(`nudge:${gs.length}`);
    });
  }

  // Teacher summary when booking closes.
  if (t >= ev.booking_closes_at) {
    tx(db, () => {
      if (!claim(db, `teacher_summary_close:${ev.id}`)) return;
      ran.push(`teacher_summary_close:${sendTeacherSummaries(db, ev)}`);
    });
  }

  // Conference reminders at each admin-set time; on a conference day the teachers get their summary too.
  const eventDays = new Set(ev.days.map((d) => d.day));
  // A reminder more than 6 hours late (the server was down, or the time was
  // added after it passed) is skipped rather than sent at a surprising moment.
  for (const r of ev.reminder_times) {
    if (t < r || t > new Date(Date.parse(r) + 6 * 3600e3).toISOString()) continue;
    tx(db, () => {
      if (!claim(db, `reminder:${ev.id}:${r}`)) return;
      const gs = db.prepare("SELECT DISTINCT guardian_id FROM bookings WHERE event_id = ? AND status = 'active'").all(ev.id);
      for (const g of gs) email.sendConferenceReminder(db, ev, g.guardian_id);
      ran.push(`reminder:${r}:${gs.length}`);
      if (eventDays.has(tz.localDate(r)) && claim(db, `teacher_summary_day:${ev.id}:${tz.localDate(r)}`)) {
        ran.push(`teacher_summary_day:${sendTeacherSummaries(db, ev)}`);
      }
    });
  }
  return ran;
}

function start(db, intervalMs = 60e3) {
  const tick = () => {
    try {
      runDue(db);
      auth.cleanup(db);
    } catch (e) {
      console.error('jobs', e);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setImmediate(tick);
  return { stop: () => clearInterval(timer) };
}

module.exports = { runDue, start, sendTeacherSummaries };
