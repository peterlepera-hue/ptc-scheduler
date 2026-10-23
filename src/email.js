'use strict';
// Email: templates, calendar (.ics) files, a durable outbox queue and a sender
// with retries. Emails are written to the `emails` table first, then sent by
// the worker, so nothing is lost if the mail service is briefly down.

const config = require('./config');
const { nowIso } = require('./db');
const tz = require('./tz');

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function icsEscape(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Fold content lines at 75 octets without splitting a UTF-8 character (RFC 5545 3.1).
function icsFold(line) {
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + b > limit) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function icsDate(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildIcs(items, { method = 'PUBLISH' } = {}) {
  const host = (() => { try { return new URL(config.baseUrl).hostname; } catch { return 'localhost'; } })();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PTC Scheduler//Conferences//EN', 'CALSCALE:GREGORIAN', `METHOD:${method}`];
  const stamp = icsDate(new Date().toISOString());
  for (const it of items) {
    lines.push('BEGIN:VEVENT', `UID:conference-${it.id}@${host}`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(it.starts_at)}`, `DTEND:${icsDate(it.ends_at)}`,
      `SUMMARY:${icsEscape(it.summary)}`, `LOCATION:${icsEscape(it.location)}`,
      `DESCRIPTION:${icsEscape(it.description)}`, 'STATUS:CONFIRMED', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:12px;padding:24px;border:1px solid #e7e5e4">
<p style="margin:0 0 4px;color:#57534e;font-size:14px">${esc(config.schoolName)}</p>
<h1 style="margin:0 0 16px;font-size:22px">${esc(title)}</h1>
${bodyHtml}
</div>
<p style="color:#78716c;font-size:13px;margin:16px 4px">Questions? Contact ${esc(config.helpContact)}.</p>
</div></body></html>`;
}

function link(path = '/') {
  return `${config.baseUrl}${path}`;
}

// ---------- family schedule ----------

function guardianSchedule(db, eventId, guardianId) {
  const rows = db.prepare(`SELECT b.id, b.starts_at, b.ends_at, b.teacher_id, b.note, t.name teacher_name, t.room
    FROM bookings b JOIN teachers t ON t.id = b.teacher_id
    WHERE b.event_id = ? AND b.guardian_id = ? AND b.status = 'active' ORDER BY b.starts_at, t.name`).all(eventId, guardianId);
  const stuQ = db.prepare(`SELECT s.first_name, s.last_name FROM booking_students bs JOIN students s ON s.id = bs.student_id
    WHERE bs.booking_id = ? ORDER BY s.first_name`);
  const coQ = db.prepare(`SELECT t.name, t.room FROM booking_slots bs JOIN teachers t ON t.id = bs.teacher_id
    WHERE bs.booking_id = ? AND bs.role = 'co' ORDER BY t.name`);
  return rows.map((r) => ({
    ...r,
    students: stuQ.all(r.id).map((s) => `${s.first_name} ${s.last_name}`),
    coTeachers: coQ.all(r.id),
  }));
}

function scheduleText(items) {
  if (!items.length) return 'You have no conferences booked.';
  return items.map((i) => {
    const co = i.coTeachers.length ? ` with ${i.coTeachers.map((c) => c.name).join(', ')}` : '';
    return `- ${tz.fmtDate(i.starts_at)}, ${tz.fmtRange(i.starts_at, i.ends_at)}: ${i.teacher_name}${co}, Room ${i.room}. About: ${i.students.join(' and ')}`;
  }).join('\n');
}

function scheduleHtml(items) {
  if (!items.length) return '<p>You have no conferences booked.</p>';
  let lastDay = '';
  let html = '';
  for (const i of items) {
    const day = tz.fmtDate(i.starts_at);
    if (day !== lastDay) { html += `<h2 style="font-size:16px;margin:16px 0 8px">${esc(day)}</h2>`; lastDay = day; }
    const co = i.coTeachers.length ? ` <span style="color:#57534e">with ${esc(i.coTeachers.map((c) => c.name).join(', '))}</span>` : '';
    html += `<div style="border:1px solid #e7e5e4;border-radius:8px;padding:12px;margin:0 0 8px">
<div style="font-weight:600">${esc(tz.fmtRange(i.starts_at, i.ends_at))} &middot; Room ${esc(i.room)}</div>
<div>${esc(i.teacher_name)}${co}</div>
<div style="color:#57534e">About ${esc(i.students.join(' and '))}</div></div>`;
  }
  return html;
}

function scheduleIcs(items, ev) {
  return buildIcs(items.map((i) => ({
    id: i.id,
    starts_at: i.starts_at,
    ends_at: i.ends_at,
    summary: `Conference: ${i.teacher_name} (${i.students.join(', ')})`,
    location: `${config.schoolName}, Room ${i.room}`,
    description: [`${ev.name}`, i.coTeachers.length ? `Also attending: ${i.coTeachers.map((c) => c.name).join(', ')}` : '', ev.location_note, `Change or cancel: ${link('/')}`].filter(Boolean).join('\n'),
  })));
}

// ---------- queue ----------

function enqueue(db, { kind, to, subject, text, html, ics = null }) {
  const id = db.prepare(`INSERT INTO emails (kind, to_email, subject, text_body, html_body, ics, status, next_try_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(kind, to, subject, text, html, ics, nowIso(), nowIso()).lastInsertRowid;
  if (worker) setImmediate(() => worker.kick());
  return Number(id);
}

// ---------- templates ----------

function sendLoginCode(db, to, code) {
  const text = `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for it, you can ignore this email.`;
  const html = layout('Your sign-in code', `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0">${esc(code)}</p>
<p>It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p>`);
  if (config.devShowCodes) console.log(`[dev] sign-in code for ${to}: ${code}`);
  return enqueue(db, { kind: 'login_code', to, subject: `${code} is your sign-in code`, text, html });
}

const CONFIRM_TITLES = {
  booked: 'Your conference is booked',
  changed: 'Your conference time changed',
  cancelled: 'Your conference was cancelled',
};

function sendFamilyConfirmation(db, ev, guardianId, reason, changedNote = '') {
  const g = db.prepare('SELECT email, name FROM guardians WHERE id = ?').get(guardianId);
  if (!g) return null;
  const items = guardianSchedule(db, ev.id, guardianId);
  const title = CONFIRM_TITLES[reason] || 'Your conference schedule';
  const intro = changedNote ? `${changedNote}\n\n` : '';
  const text = `Hello ${g.name},\n\n${intro}Here is your full conference schedule for ${ev.name}:\n\n${scheduleText(items)}\n\n${ev.location_note ? ev.location_note + '\n\n' : ''}To change or cancel, sign in at ${link('/')}\nChanges online close ${tz.fmtDateTime(ev.change_cutoff_at)}.\n\nQuestions? Contact ${config.helpContact}.`;
  const html = layout(title, `<p>Hello ${esc(g.name)},</p>${changedNote ? `<p>${esc(changedNote)}</p>` : ''}
<p>Here is your full conference schedule for <b>${esc(ev.name)}</b>:</p>${scheduleHtml(items)}
${ev.location_note ? `<p>${esc(ev.location_note)}</p>` : ''}
<p><a href="${esc(link('/'))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Change or cancel</a></p>
<p style="color:#57534e;font-size:14px">Changes online close ${esc(tz.fmtDateTime(ev.change_cutoff_at))}.</p>`);
  return enqueue(db, { kind: `confirmation_${reason}`, to: g.email, subject: `${title}: ${ev.name}`, text, html, ics: items.length ? scheduleIcs(items, ev) : null });
}

function sendSlotCancelled(db, ev, guardianId, booking, teacherName, reason) {
  const g = db.prepare('SELECT email, name FROM guardians WHERE id = ?').get(guardianId);
  if (!g) return null;
  const what = `Your ${tz.fmtDate(booking.starts_at)} ${tz.fmtRange(booking.starts_at, booking.ends_at)} conference with ${teacherName} was cancelled by the school${reason ? ` (${reason})` : ''}.`;
  const items = guardianSchedule(db, ev.id, guardianId);
  const text = `Hello ${g.name},\n\n${what}\n\nYou can pick a new time at ${link('/')} or contact ${config.helpContact}.\n\nYour current schedule:\n${scheduleText(items)}`;
  const html = layout('A conference was cancelled', `<p>Hello ${esc(g.name)},</p><p>${esc(what)}</p>
<p><a href="${esc(link('/'))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Pick a new time</a></p>
<p>Your current schedule:</p>${scheduleHtml(items)}`);
  return enqueue(db, { kind: 'slot_cancelled', to: g.email, subject: `Conference cancelled: ${teacherName}`, text, html, ics: items.length ? scheduleIcs(items, ev) : null });
}

function sendBookingOpen(db, ev, g) {
  const text = `Hello ${g.name},\n\nBooking is open for ${ev.name}.\n\nSign in at ${link('/')} with this email address and your child's date of birth. We will email you a 6-digit code to finish signing in.\n\nPlease book by ${tz.fmtDateTime(ev.booking_closes_at)}. Each child can have up to ${ev.max_per_child} conferences.\n\nQuestions? Contact ${config.helpContact}.`;
  const html = layout(`Book your ${ev.name}`, `<p>Hello ${esc(g.name)},</p><p>Booking is open for <b>${esc(ev.name)}</b>.</p>
<p>Sign in with <b>this email address</b> and <b>your child's date of birth</b>. We will email you a 6-digit code to finish signing in.</p>
<p><a href="${esc(link('/'))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Book conferences</a></p>
<p>Please book by <b>${esc(tz.fmtDateTime(ev.booking_closes_at))}</b>. Each child can have up to ${ev.max_per_child} conferences.</p>`);
  return enqueue(db, { kind: 'booking_open', to: g.email, subject: `Book your ${ev.name}`, text, html });
}

function sendBookingNudge(db, ev, g) {
  const text = `Hello ${g.name},\n\nYou have not booked any conferences for ${ev.name} yet. Booking closes ${tz.fmtDateTime(ev.booking_closes_at)}.\n\nBook at ${link('/')}\n\nQuestions? Contact ${config.helpContact}.`;
  const html = layout('Reminder: book your conferences', `<p>Hello ${esc(g.name)},</p><p>You have not booked any conferences for <b>${esc(ev.name)}</b> yet. Booking closes <b>${esc(tz.fmtDateTime(ev.booking_closes_at))}</b>.</p>
<p><a href="${esc(link('/'))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Book conferences</a></p>`);
  return enqueue(db, { kind: 'booking_nudge', to: g.email, subject: `Reminder: book your ${ev.name}`, text, html });
}

function sendConferenceReminder(db, ev, guardianId) {
  const g = db.prepare('SELECT email, name FROM guardians WHERE id = ?').get(guardianId);
  const items = guardianSchedule(db, ev.id, guardianId);
  if (!g || !items.length) return null;
  const text = `Hello ${g.name},\n\nA reminder of your conferences for ${ev.name}:\n\n${scheduleText(items)}\n\n${ev.location_note ? ev.location_note + '\n\n' : ''}To change, sign in at ${link('/')} (online changes close ${tz.fmtDateTime(ev.change_cutoff_at)}).\n\nQuestions? Contact ${config.helpContact}.`;
  const html = layout(`Reminder: ${ev.name}`, `<p>Hello ${esc(g.name)},</p><p>A reminder of your conferences:</p>${scheduleHtml(items)}
${ev.location_note ? `<p><b>Getting there:</b> ${esc(ev.location_note)}</p>` : ''}
<p><a href="${esc(link('/'))}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">View or change</a></p>
<p style="color:#57534e;font-size:14px">Online changes close ${esc(tz.fmtDateTime(ev.change_cutoff_at))}.</p>`);
  return enqueue(db, { kind: 'conference_reminder', to: g.email, subject: `Reminder: your conferences on ${tz.fmtDate(items[0].starts_at)}`, text, html, ics: scheduleIcs(items, ev) });
}

function sendTeacherSummary(db, ev, teacher, schedule, attempts) {
  const booked = schedule.filter((s) => s.booking);
  const lines = booked.map((s) => `- ${tz.fmtDate(s.starts_at)} ${tz.fmtRange(s.starts_at, s.ends_at)}: ${s.booking.students.join(', ')} / ${s.booking.guardian_name} (${s.booking.guardian_email})${s.booking.co_teachers.length ? ` with ${s.booking.co_teachers.join(', ')}` : ''}${s.booking.note ? ` Note: ${s.booking.note}` : ''}`);
  const tried = attempts.map((a) => `- ${a.student_name} / ${a.guardian_name} (${a.guardian_email}), ${tz.fmtDateTime(a.created_at)}${a.note ? `: ${a.note}` : ''} [${a.status}]`);
  const text = `Hello ${teacher.name},\n\nYour schedule for ${ev.name} (Room ${teacher.room}):\n\n${lines.join('\n') || 'No conferences booked.'}\n\nParents who tried to book after your slots filled:\n${tried.join('\n') || 'None.'}\n\nFull schedule: ${link('/#/staff')}`;
  const rows = booked.map((s) => `<tr><td style="padding:6px;border-bottom:1px solid #e7e5e4;white-space:nowrap">${esc(tz.fmtRange(s.starts_at, s.ends_at))}</td><td style="padding:6px;border-bottom:1px solid #e7e5e4">${esc(s.booking.students.join(', '))}</td><td style="padding:6px;border-bottom:1px solid #e7e5e4">${esc(s.booking.guardian_name)}</td><td style="padding:6px;border-bottom:1px solid #e7e5e4">${esc(s.booking.note)}</td></tr>`).join('');
  const html = layout(`Your conference schedule`, `<p>Hello ${esc(teacher.name)}, here is your schedule for <b>${esc(ev.name)}</b> (Room ${esc(teacher.room)}).</p>
${booked.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><tr><th align="left" style="padding:6px">Time</th><th align="left" style="padding:6px">Student</th><th align="left" style="padding:6px">Parent</th><th align="left" style="padding:6px">Note</th></tr>${rows}</table>` : '<p>No conferences booked.</p>'}
<h2 style="font-size:16px;margin-top:20px">Tried to book (${attempts.length})</h2>
${attempts.length ? `<ul>${attempts.map((a) => `<li>${esc(a.student_name)} / ${esc(a.guardian_name)} (${esc(a.guardian_email)})${a.note ? `: ${esc(a.note)}` : ''}</li>`).join('')}</ul>` : '<p>None.</p>'}
<p><a href="${esc(link('/#/staff'))}">Open your full schedule</a></p>`);
  return enqueue(db, { kind: 'teacher_summary', to: teacher.email, subject: `Your conference schedule: ${ev.name}`, text, html });
}

// ---------- sending ----------

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (config.mailTransport === 'smtp') {
    if (!config.smtpUrl) throw new Error('MAIL_TRANSPORT=smtp needs SMTP_URL');
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport(config.smtpUrl);
    transport = {
      async send(m) {
        const info = await t.sendMail({
          from: config.mailFrom, to: m.to_email, subject: m.subject, text: m.text_body, html: m.html_body,
          attachments: m.ics ? [{ filename: 'conferences.ics', content: m.ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] : [],
        });
        return info.messageId || null;
      },
    };
  } else {
    // Outbox mode: emails are stored and visible to admins, but not delivered.
    transport = { async send() { return 'outbox'; } };
  }
  return transport;
}

function setTransportForTests(t) { transport = t; }

const BACKOFF_MIN = [1, 5, 15, 60, 180];

async function sendDue(db, { limit = 25 } = {}) {
  const due = db.prepare(`SELECT * FROM emails WHERE status = 'queued' AND next_try_at <= ?
    ORDER BY CASE kind WHEN 'login_code' THEN 0 ELSE 1 END, id LIMIT ?`).all(nowIso(), limit);
  let sent = 0;
  let attempted = 0;
  for (const m of due) {
    const claimed = db.prepare("UPDATE emails SET status = 'sending' WHERE id = ? AND status = 'queued'").run(m.id).changes;
    if (!claimed) continue;
    attempted++;
    try {
      const pid = await getTransport().send(m);
      db.prepare("UPDATE emails SET status = 'sent', sent_at = ?, provider_id = ?, tries = tries + 1, last_error = NULL WHERE id = ?").run(nowIso(), pid, m.id);
      sent++;
    } catch (e) {
      const tries = m.tries + 1;
      const giveUp = tries >= BACKOFF_MIN.length + 1;
      const next = new Date(Date.now() + (BACKOFF_MIN[Math.min(tries - 1, BACKOFF_MIN.length - 1)]) * 60e3).toISOString();
      db.prepare('UPDATE emails SET status = ?, tries = ?, next_try_at = ?, last_error = ? WHERE id = ?')
        .run(giveUp ? 'failed' : 'queued', tries, next, String(e && e.message).slice(0, 500), m.id);
      if (giveUp) markAddress(db, m.to_email, 'failed', String(e && e.message).slice(0, 300));
    }
  }
  return { sent, attempted, more: due.length === limit };
}

function markAddress(db, email, status, detail) {
  db.prepare('UPDATE guardians SET email_status = ?, email_status_detail = ? WHERE email = ?').run(status, detail || null, String(email).toLowerCase());
}

let worker = null;
function startWorker(db, intervalMs = 5000) {
  db.prepare("UPDATE emails SET status = 'queued' WHERE status = 'sending'").run();
  let running = false;
  let again = false;
  const run = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        // Keep going while a full batch came back, so big mailings drain quickly.
        for (let i = 0; i < 40; i++) { const r = await sendDue(db); if (!r.more) break; }
      } while (again);
    } catch (e) { console.error('email worker', e); } finally { running = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  worker = { kick: run, stop: () => clearInterval(timer) };
  return worker;
}

module.exports = {
  esc, buildIcs, icsFold, enqueue, guardianSchedule, scheduleIcs, sendLoginCode, sendFamilyConfirmation, sendSlotCancelled,
  sendBookingOpen, sendBookingNudge, sendConferenceReminder, sendTeacherSummary, sendDue, startWorker, markAddress,
  setTransportForTests,
};
