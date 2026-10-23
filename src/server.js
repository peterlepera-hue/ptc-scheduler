'use strict';
// HTTP server: security headers, sessions, JSON API and the static web app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const dbm = require('./db');
const auth = require('./auth');
const events = require('./events');
const booking = require('./booking');
const services = require('./services');
const importer = require('./importer');
const email = require('./email');
const roster = require('./roster');
const jobs = require('./jobs');
const tz = require('./tz');
const { toCsv } = require('./csv');

const COOKIE = 'ptc_session';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// ---------- small helpers ----------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`;
}

function securityHeaders(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (config.trustProxy) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '';
}

// Per-IP limit on sign-in requests, on top of the per-email lockout.
const ipHits = new Map();
function ipLimited(ip, max = 120, windowMs = 10 * 60e3) {
  const now = Date.now();
  let h = ipHits.get(ip);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; ipHits.set(ip, h); }
  h.n++;
  if (ipHits.size > 50000) for (const [k, v] of ipHits) if (v.reset < now) ipHits.delete(k);
  return h.n > max;
}

function int(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return n;
}

function iso(v, name) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) throw new HttpError(400, `Invalid ${name}.`);
  return s;
}

function needEvent(db) {
  const ev = events.currentEvent(db);
  if (!ev) throw new HttpError(409, 'No conference event has been set up yet.');
  return ev;
}

function csvResponse(res, filename, header, rows) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(toCsv(header, rows));
}

function bookingResult(r) {
  if (r.ok) return r;
  throw new HttpError(409, r.message, { code: r.code, alternatives: r.alternatives });
}

// ---------- routes ----------

function routes(db) {
  const R = [];
  const add = (method, pattern, guard, handler, opts = {}) => R.push({ method, pattern, guard, handler, opts });

  // --- public ---
  add('GET', /^\/api\/me$/, null, ({ session }) => {
    const ev = events.currentEvent(db);
    const base = { demo: config.demoMode, school: config.schoolName, help: config.helpContact, timeZone: config.timeZone, event: services.eventSummary(ev) };
    if (!session) return { ...base, role: null };
    if (session.kind === 'parent') return { ...base, role: 'parent', name: session.guardian.name, email: session.guardian.email };
    return { ...base, role: 'staff', email: session.email, isAdmin: session.isAdmin, teacher: session.teacher };
  });

  add('POST', /^\/api\/parent\/login$/, null, ({ body, ip }) => {
    if (ipLimited(`login:${ip}`)) throw new HttpError(429, 'Too many sign-in attempts from this network. Please wait a few minutes.');
    const r = auth.parentStart(db, body.email, body.dob);
    if (!r.ok) throw new HttpError(r.code === 'LOCKED' ? 429 : 401, r.message, { code: r.code });
    return r.demoCode ? { ok: true, demoCode: r.demoCode } : { ok: true };
  });

  add('POST', /^\/api\/parent\/verify$/, null, ({ body, ip, res }) => {
    if (ipLimited(`login:${ip}`)) throw new HttpError(429, 'Too many sign-in attempts from this network. Please wait a few minutes.');
    const r = auth.parentVerify(db, body.email, body.code);
    if (!r.ok) throw new HttpError(r.code === 'LOCKED' ? 429 : 401, r.message, { code: r.code });
    res.setHeader('Set-Cookie', cookieHeader(r.token, 12 * 3600));
    return { ok: true };
  });

  add('POST', /^\/api\/staff\/login$/, null, ({ body, ip }) => {
    if (ipLimited(`login:${ip}`)) throw new HttpError(429, 'Too many sign-in attempts from this network. Please wait a few minutes.');
    const r = auth.staffStart(db, body.email);
    return r.demoCode ? { ok: true, demoCode: r.demoCode } : { ok: true };
  });

  add('POST', /^\/api\/staff\/verify$/, null, ({ body, ip, res }) => {
    if (ipLimited(`login:${ip}`)) throw new HttpError(429, 'Too many sign-in attempts from this network. Please wait a few minutes.');
    const r = auth.staffVerify(db, body.email, body.code);
    if (!r.ok) throw new HttpError(r.code === 'LOCKED' ? 429 : 401, r.message, { code: r.code });
    res.setHeader('Set-Cookie', cookieHeader(r.token, 12 * 3600));
    return { ok: true };
  });

  add('POST', /^\/api\/logout$/, null, ({ token, res }) => {
    auth.endSession(db, token);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return { ok: true };
  });

  // Delivery problems reported by the email provider (see README).
  add('POST', /^\/api\/webhooks\/email-events$/, null, ({ body, req }) => {
    if (!config.emailWebhookSecret || req.headers['x-webhook-secret'] !== config.emailWebhookSecret) throw new HttpError(403, 'Forbidden');
    const list = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
    let n = 0;
    for (const e of list.slice(0, 1000)) {
      const addr = String(e.email || e.recipient || e.Email || '').toLowerCase();
      if (!addr) continue;
      const kind = String(e.type || e.event || e.RecordType || 'bounce').toLowerCase();
      email.markAddress(db, addr, /complain|spam/.test(kind) ? 'complained' : 'bounced', String(e.reason || e.Description || kind).slice(0, 300));
      db.prepare("UPDATE emails SET status = 'bounced', last_error = ? WHERE id = (SELECT id FROM emails WHERE to_email = ? AND status = 'sent' ORDER BY id DESC LIMIT 1)")
        .run(String(e.reason || kind).slice(0, 300), addr);
      n++;
    }
    return { ok: true, updated: n };
  }, { csrf: false });

  // --- parent ---
  const parent = (s) => s && s.kind === 'parent';
  add('GET', /^\/api\/parent\/overview$/, parent, ({ session }) => {
    const ev = events.currentEvent(db);
    return services.parentOverview(db, ev, session.guardian.id);
  });

  add('GET', /^\/api\/parent\/teachers\/(\d+)\/slots$/, parent, ({ session, m, query }) => {
    const ev = needEvent(db);
    const ignore = query.get('booking') ? int(query.get('booking'), 'booking') : null;
    const r = booking.slotOptions(db, ev.id, session.guardian.id, int(m[1], 'teacher'), { ignoreBookingId: ignore });
    if (!r.covered.length) throw new HttpError(404, 'Teacher not found.');
    return { options: r.options, co_teachers: r.coTeachers };
  });

  add('POST', /^\/api\/parent\/bookings$/, parent, ({ session, body }) => {
    const ev = needEvent(db);
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Nothing to book.');
    const items = body.items.map((it) => ({ teacher_id: int(it.teacher_id, 'teacher'), starts_at: iso(it.starts_at, 'time'), student_id: int(it.student_id, 'child'), note: String(it.note || '') }));
    return { results: services.parentConfirm(db, ev, session.guardian, items) };
  });

  const parentWho = (session) => ({ role: 'parent', actor: session.actor, guardianId: session.guardian.id });
  add('POST', /^\/api\/parent\/bookings\/(\d+)\/cancel$/, parent, ({ session, m }) => {
    const ev = needEvent(db);
    return bookingResult(services.cancelAndNotify(db, ev, int(m[1], 'booking'), parentWho(session)));
  });

  add('POST', /^\/api\/parent\/bookings\/(\d+)\/move$/, parent, ({ session, m, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.moveAndNotify(db, ev, int(m[1], 'booking'), iso(body.starts_at, 'time'), parentWho(session)));
  });

  add('POST', /^\/api\/parent\/attempts$/, parent, ({ session, body }) => {
    const ev = needEvent(db);
    try {
      return booking.recordAttempt(db, { eventId: ev.id, guardianId: session.guardian.id, teacherId: int(body.teacher_id, 'teacher'), studentId: int(body.student_id, 'child'), note: body.note, actor: session.actor });
    } catch (e) {
      if (e instanceof booking.BookingError) throw new HttpError(409, e.message, { code: e.code });
      throw e;
    }
  });

  // --- teacher ---
  const teacher = (s) => s && s.kind === 'staff' && s.teacher;
  const teacherWho = (session) => ({ role: 'teacher', actor: `teacher:${session.email}`, teacherId: session.teacher.id });

  add('GET', /^\/api\/teacher\/schedule$/, teacher, ({ session }) => {
    const ev = events.currentEvent(db);
    const sched = services.teacherSchedule(db, ev, session.teacher.id);
    return { event: services.eventSummary(ev), teacher: session.teacher, ...sched };
  });

  add('GET', /^\/api\/teacher\/roster$/, teacher, ({ session }) => {
    return { students: roster.rosterForTeacher(db, session.teacher.id).filter((s) => s.role === 'teacher') };
  });

  add('POST', /^\/api\/teacher\/slots\/(\d+)\/(block|unblock)$/, teacher, ({ session, m, body }) => {
    const ev = needEvent(db);
    const r = services.setSlotBlocked(db, ev, int(m[1], 'slot'), m[2] === 'block', body.reason, teacherWho(session));
    if (!r.ok) throw new HttpError(409, r.message);
    return r;
  });

  add('POST', /^\/api\/teacher\/attempts\/(\d+)$/, teacher, ({ session, m, body }) => {
    const ev = needEvent(db);
    const r = services.setAttemptStatus(db, ev, int(m[1], 'id'), String(body.status), teacherWho(session));
    if (!r.ok) throw new HttpError(409, r.message);
    return r;
  });

  add('POST', /^\/api\/teacher\/bookings$/, teacher, ({ session, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.staffBook(db, ev, {
      teacherId: session.teacher.id, startsAt: iso(body.starts_at, 'time'), studentId: int(body.student_id, 'student'),
      guardianId: int(body.guardian_id, 'parent'), note: body.note,
    }, teacherWho(session)));
  });

  add('POST', /^\/api\/teacher\/bookings\/(\d+)\/cancel$/, teacher, ({ session, m, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.cancelAndNotify(db, ev, int(m[1], 'booking'), teacherWho(session), String(body.reason || '')));
  });

  add('POST', /^\/api\/teacher\/bookings\/(\d+)\/move$/, teacher, ({ session, m, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.moveAndNotify(db, ev, int(m[1], 'booking'), iso(body.starts_at, 'time'), teacherWho(session)));
  });

  add('GET', /^\/api\/teacher\/export\.csv$/, teacher, ({ session, res }) => {
    const ev = needEvent(db);
    const { slots } = services.teacherSchedule(db, ev, session.teacher.id);
    csvResponse(res, `schedule-${session.teacher.name}.csv`,
      ['Date', 'Start', 'End', 'Status', 'Student', 'Parent / guardian', 'Parent email', 'Note from parent', 'Also attending'],
      slots.map((s) => [tz.localDate(s.starts_at), tz.fmtTime(s.starts_at), tz.fmtTime(s.ends_at),
        s.booking ? 'Booked' : s.status === 'blocked' ? `Blocked${s.block_reason ? `: ${s.block_reason}` : ''}` : 'Open',
        s.booking ? s.booking.students.join('; ') : '', s.booking ? s.booking.guardian_name : '', s.booking ? s.booking.guardian_email : '',
        s.booking ? s.booking.note : '', s.booking ? [s.booking.main_teacher !== session.teacher.name ? s.booking.main_teacher : '', ...s.booking.co_teachers].filter(Boolean).join('; ') : '']));
    return undefined;
  });

  // --- admin ---
  const admin = (s) => s && s.kind === 'staff' && s.isAdmin;
  const adminWho = (session) => ({ role: 'admin', actor: `admin:${session.email}` });

  add('POST', /^\/api\/admin\/upload\/(validate|import)$/, admin, async ({ session, body, m }) => {
    const files = {};
    for (const key of Object.keys(importer.FILES)) {
      const f = body.files && body.files[key];
      if (f && f.data) files[key] = { name: String(f.name || ''), data: Buffer.from(String(f.data), 'base64') };
    }
    const report = await importer.validate(files, db);
    const out = { errors: report.errors, warnings: report.warnings, summary: report.summary || null, imported: false };
    if (m[1] === 'import' && report.data) {
      importer.importData(db, report.data, adminWho(session).actor, events.ensureSlots);
      out.imported = true;
    }
    return out;
  }, { limit: 40 * 1024 * 1024 });

  add('GET', /^\/api\/admin\/event$/, admin, () => {
    const ev = events.currentEvent(db);
    if (!ev) return { event: null };
    return {
      event: {
        ...services.eventSummary(ev),
        booking_opens_local: tz.isoToLocalInput(ev.booking_opens_at),
        booking_closes_local: tz.isoToLocalInput(ev.booking_closes_at),
        reminder_times_local: ev.reminder_times.map((r) => tz.isoToLocalInput(r)),
        open_email_sent_at: ev.open_email_sent_at,
      },
    };
  });

  add('POST', /^\/api\/admin\/event$/, admin, ({ session, body }) => {
    const ev = events.currentEvent(db);
    const input = { ...body };
    if (!ev && (!Array.isArray(input.reminder_times) || !input.reminder_times.length) && Array.isArray(input.days)) {
      input.reminder_times = events.defaultReminders(input.days.filter((d) => tz.isValidYMD(d.day)).sort((a, b) => a.day.localeCompare(b.day)));
    }
    const r = events.saveEvent(db, input, adminWho(session).actor, body.new_event ? null : ev ? ev.id : null);
    if (r.errors) throw new HttpError(400, r.errors.join(' '), { errors: r.errors });
    return { ok: true, id: r.id, slots: r.slots };
  });

  add('POST', /^\/api\/admin\/event\/send-open-email$/, admin, ({ session }) => {
    const ev = needEvent(db);
    return services.sendBookingOpenEmails(db, ev, adminWho(session));
  });

  add('GET', /^\/api\/admin\/dashboard$/, admin, () => services.dashboard(db, events.currentEvent(db)));

  add('GET', /^\/api\/admin\/families$/, admin, ({ query }) => {
    const q = `%${String(query.get('q') || '').trim().toLowerCase()}%`;
    const rows = db.prepare(`SELECT DISTINCT g.id, g.name, g.email, g.email_status FROM guardians g
      JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id
      WHERE g.active = 1 AND (lower(g.name) LIKE ? OR g.email LIKE ? OR lower(s.first_name || ' ' || s.last_name) LIKE ? OR s.sis_id LIKE ?)
      ORDER BY g.name COLLATE NOCASE LIMIT 50`).all(q, q, q, q);
    const kids = db.prepare(`SELECT s.id, s.first_name, s.last_name, s.sis_id FROM student_guardians sg JOIN students s ON s.id = sg.student_id
      WHERE sg.guardian_id = ? AND s.active = 1 ORDER BY s.first_name`);
    return { families: rows.map((r) => ({ ...r, children: kids.all(r.id) })) };
  });

  add('GET', /^\/api\/admin\/family\/(\d+)$/, admin, ({ m }) => {
    const gid = int(m[1], 'parent');
    const g = db.prepare('SELECT id, name, email, email_status, email_status_detail FROM guardians WHERE id = ?').get(gid);
    if (!g) throw new HttpError(404, 'Parent not found.');
    return { guardian: g, ...services.parentOverview(db, events.currentEvent(db), gid) };
  });

  add('GET', /^\/api\/admin\/family\/(\d+)\/teachers\/(\d+)\/slots$/, admin, ({ m, query }) => {
    const ev = needEvent(db);
    const ignore = query.get('booking') ? int(query.get('booking'), 'booking') : null;
    const r = booking.slotOptions(db, ev.id, int(m[1], 'parent'), int(m[2], 'teacher'), { ignoreBookingId: ignore });
    return { options: r.options, co_teachers: r.coTeachers };
  });

  add('POST', /^\/api\/admin\/bookings$/, admin, ({ session, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.staffBook(db, ev, {
      teacherId: int(body.teacher_id, 'teacher'), startsAt: iso(body.starts_at, 'time'), studentId: int(body.student_id, 'student'),
      guardianId: int(body.guardian_id, 'parent'), note: body.note,
    }, adminWho(session)));
  });

  add('POST', /^\/api\/admin\/bookings\/(\d+)\/cancel$/, admin, ({ session, m, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.cancelAndNotify(db, ev, int(m[1], 'booking'), adminWho(session), String(body.reason || '')));
  });

  add('POST', /^\/api\/admin\/bookings\/(\d+)\/move$/, admin, ({ session, m, body }) => {
    const ev = needEvent(db);
    return bookingResult(services.moveAndNotify(db, ev, int(m[1], 'booking'), iso(body.starts_at, 'time'), adminWho(session)));
  });

  add('POST', /^\/api\/admin\/limits$/, admin, ({ session, body }) => {
    const ev = needEvent(db);
    const sid = int(body.student_id, 'student');
    const max = body.max === null || body.max === '' ? null : Number(body.max);
    if (max !== null && (!Number.isInteger(max) || max < 0 || max > 50)) throw new HttpError(400, 'Limit must be a whole number from 0 to 50.');
    dbm.tx(db, () => {
      if (max === null) db.prepare('DELETE FROM child_limits WHERE event_id = ? AND student_id = ?').run(ev.id, sid);
      else db.prepare('INSERT INTO child_limits (event_id, student_id, max_conferences) VALUES (?, ?, ?) ON CONFLICT(event_id, student_id) DO UPDATE SET max_conferences = excluded.max_conferences').run(ev.id, sid, max);
      dbm.audit(db, adminWho(session).actor, 'limit.set', { studentId: sid, max });
    });
    return { ok: true };
  });

  add('GET', /^\/api\/admin\/teachers$/, admin, () => ({
    teachers: db.prepare('SELECT id, name, email, room, room_locked, active FROM teachers ORDER BY active DESC, name COLLATE NOCASE').all(),
  }));

  add('GET', /^\/api\/admin\/teachers\/(\d+)\/schedule$/, admin, ({ m }) => {
    const ev = needEvent(db);
    const t = db.prepare('SELECT id, name, email, room FROM teachers WHERE id = ?').get(int(m[1], 'teacher'));
    if (!t) throw new HttpError(404, 'Teacher not found.');
    return { teacher: t, ...services.teacherSchedule(db, ev, t.id) };
  });

  add('GET', /^\/api\/admin\/teachers\/(\d+)\/roster$/, admin, ({ m }) => ({
    students: roster.rosterForTeacher(db, int(m[1], 'teacher')).filter((s) => s.role === 'teacher'),
  }));

  add('POST', /^\/api\/admin\/teachers\/(\d+)\/room$/, admin, ({ session, m, body }) => {
    const room = String(body.room || '').trim();
    if (!room) throw new HttpError(400, 'Room is required.');
    const id = int(m[1], 'teacher');
    dbm.tx(db, () => {
      db.prepare('UPDATE teachers SET room = ?, room_locked = 1 WHERE id = ?').run(room.slice(0, 50), id);
      dbm.audit(db, adminWho(session).actor, 'teacher.room', { teacherId: id, room });
    });
    return { ok: true };
  });

  add('POST', /^\/api\/admin\/teachers\/(\d+)\/unavailable$/, admin, ({ session, m, body }) => {
    const ev = needEvent(db);
    return services.teacherUnavailable(db, ev, int(m[1], 'teacher'), String(body.reason || ''), adminWho(session));
  });

  add('POST', /^\/api\/admin\/slots\/(\d+)\/(block|unblock)$/, admin, ({ session, m, body }) => {
    const ev = needEvent(db);
    const r = services.setSlotBlocked(db, ev, int(m[1], 'slot'), m[2] === 'block', body.reason, adminWho(session));
    if (!r.ok) throw new HttpError(409, r.message);
    return r;
  });

  add('POST', /^\/api\/admin\/attempts\/(\d+)$/, admin, ({ session, m, body }) => {
    const ev = needEvent(db);
    const r = services.setAttemptStatus(db, ev, int(m[1], 'id'), String(body.status), adminWho(session));
    if (!r.ok) throw new HttpError(409, r.message);
    return r;
  });

  add('GET', /^\/api\/admin\/emails$/, admin, ({ query }) => {
    const q = String(query.get('q') || '').trim().toLowerCase();
    const rows = db.prepare(`SELECT id, kind, to_email, subject, status, tries, last_error, created_at, sent_at FROM emails
      WHERE (? = '' OR to_email LIKE ?) AND kind <> 'login_code' ORDER BY id DESC LIMIT 200`).all(q, `%${q}%`);
    return { emails: rows, transport: config.mailTransport };
  });

  add('GET', /^\/api\/admin\/emails\/(\d+)$/, admin, ({ m }) => {
    const e = db.prepare("SELECT id, kind, to_email, subject, text_body, html_body, status, created_at, sent_at, last_error FROM emails WHERE id = ? AND kind <> 'login_code'").get(int(m[1], 'id'));
    if (!e) throw new HttpError(404, 'Email not found.');
    return { email: e };
  });

  add('POST', /^\/api\/admin\/emails\/(\d+)\/resend$/, admin, ({ session, m }) => {
    const id = int(m[1], 'id');
    return dbm.tx(db, () => {
      const e = db.prepare("SELECT * FROM emails WHERE id = ? AND kind <> 'login_code'").get(id);
      if (!e) throw new HttpError(404, 'Email not found.');
      const nid = email.enqueue(db, { kind: e.kind, to: e.to_email, subject: e.subject, text: e.text_body, html: e.html_body, ics: e.ics });
      db.prepare("UPDATE guardians SET email_status = 'ok', email_status_detail = NULL WHERE email = ?").run(e.to_email);
      dbm.audit(db, adminWho(session).actor, 'email.resend', { from: id, to: nid });
      return { ok: true, id: nid };
    });
  });

  add('POST', /^\/api\/admin\/family\/(\d+)\/send-schedule$/, admin, ({ session, m }) => {
    const ev = needEvent(db);
    const gid = int(m[1], 'parent');
    const id = email.sendFamilyConfirmation(db, ev, gid, 'schedule');
    dbm.audit(db, adminWho(session).actor, 'email.schedule', { guardianId: gid });
    return { ok: Boolean(id) };
  });

  add('GET', /^\/api\/admin\/audit$/, admin, () => ({
    entries: db.prepare('SELECT id, at, actor, action, details FROM audit_log ORDER BY id DESC LIMIT 500').all(),
  }));

  add('GET', /^\/api\/admin\/master$/, admin, () => {
    const ev = needEvent(db);
    return { event: services.eventSummary(ev), rows: services.masterRows(db, ev) };
  });

  add('GET', /^\/api\/admin\/export\/(teacher|room|family)\.csv$/, admin, ({ m, res }) => {
    const ev = needEvent(db);
    const rows = services.masterRows(db, ev);
    const by = m[1];
    const key = (r) => (by === 'teacher' ? `${r.teacher_name}\u0000${r.starts_at}` : by === 'room' ? `${r.room}\u0000${r.starts_at}` : `${r.guardian_name}\u0000${r.guardian_email}\u0000${r.starts_at}`);
    rows.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
    const header = by === 'family'
      ? ['Parent / guardian', 'Parent email', 'Date', 'Start', 'End', 'Teacher', 'Room', 'Student(s)', 'Also attending', 'Note']
      : by === 'room'
        ? ['Room', 'Date', 'Start', 'End', 'Teacher', 'Student(s)', 'Parent / guardian', 'Parent email', 'Also attending', 'Note']
        : ['Teacher', 'Teacher email', 'Room', 'Date', 'Start', 'End', 'Student(s)', 'Parent / guardian', 'Parent email', 'Also attending', 'Note'];
    const out = rows.map((r) => {
      const d = tz.localDate(r.starts_at); const s = tz.fmtTime(r.starts_at); const e = tz.fmtTime(r.ends_at);
      if (by === 'family') return [r.guardian_name, r.guardian_email, d, s, e, r.teacher_name, r.room, r.students, r.co_teachers, r.note];
      if (by === 'room') return [r.room, d, s, e, r.teacher_name, r.students, r.guardian_name, r.guardian_email, r.co_teachers, r.note];
      return [r.teacher_name, r.teacher_email, r.room, d, s, e, r.students, r.guardian_name, r.guardian_email, r.co_teachers, r.note];
    });
    csvResponse(res, `master-schedule-by-${by}.csv`, header, out);
    return undefined;
  });

  add('GET', /^\/api\/admin\/admins$/, admin, () => ({
    admins: db.prepare('SELECT email, name FROM admins ORDER BY email').all(), fromConfig: config.adminEmails,
  }));

  add('POST', /^\/api\/admin\/admins$/, admin, ({ session, body }) => {
    const e = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email.');
    dbm.tx(db, () => {
      if (body.remove) {
        if (e === session.email) throw new HttpError(400, "You can't remove yourself.");
        db.prepare('DELETE FROM admins WHERE email = ?').run(e);
      } else db.prepare('INSERT OR IGNORE INTO admins (email, name) VALUES (?, ?)').run(e, String(body.name || '').slice(0, 100));
      dbm.audit(db, adminWho(session).actor, body.remove ? 'admin.remove' : 'admin.add', { email: e });
    });
    return { ok: true };
  });

  // Deletes student, parent and booking details after the event (FERPA retention).
  add('POST', /^\/api\/admin\/purge$/, admin, ({ session, body }) => {
    if (body.confirm !== 'DELETE ALL FAMILY DATA') throw new HttpError(400, 'Type the confirmation phrase exactly.');
    const counts = dbm.tx(db, () => {
      const summary = db.prepare("SELECT event_id, COUNT(*) n FROM bookings WHERE status = 'active' GROUP BY event_id").all();
      for (const t of ['booking_slots', 'booking_students', 'attempt_teachers', 'attempts', 'bookings', 'child_limits', 'supports', 'enrollments',
        'student_guardians', 'students', 'guardians', 'login_codes', 'login_failures', 'emails']) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM sessions WHERE kind = 'parent'").run();
      dbm.setMeta(db, `purged_at:${dbm.nowIso()}`, JSON.stringify(summary));
      dbm.audit(db, adminWho(session).actor, 'purge', { bookingCounts: summary });
      return summary;
    });
    return { ok: true, counts };
  });

  return R;
}

// ---------- server ----------

function createServer({ dbFile } = {}) {
  const db = dbm.open(dbFile || path.join(config.dataDir, 'ptc.sqlite'));
  for (const e of config.adminEmails) db.prepare('INSERT OR IGNORE INTO admins (email) VALUES (?)').run(e);
  const table = routes(db);

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        const f = STATIC[url.pathname];
        if (!f) throw new HttpError(404, 'Not found');
        const body = fs.readFileSync(path.join(PUBLIC_DIR, f[0]));
        res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const route = table.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) throw new HttpError(404, 'Not found');
      const m = route.pattern.exec(url.pathname);
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = auth.sessionFor(db, token);
      if (route.guard && !route.guard(session)) throw new HttpError(session ? 403 : 401, session ? 'You do not have access to this page.' : 'Please sign in.');
      let body = {};
      if (req.method === 'POST') {
        // Cross-site request protection: browsers will not send this header (or
        // a JSON content type) cross-origin without a CORS preflight we never allow.
        if (route.opts.csrf !== false && req.headers['x-requested-with'] !== 'ptc') throw new HttpError(403, 'Forbidden');
        if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Send JSON.');
        const raw = await readBody(req, route.opts.limit || 256 * 1024);
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
        if (body === null || typeof body !== 'object') throw new HttpError(400, 'Invalid JSON.');
      }
      const out = await route.handler({ req, res, m, body, session, token, query: url.searchParams, ip: clientIp(req) });
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.message, code: e.code, alternatives: e.alternatives, errors: e.errors });
      } else {
        console.error(e);
        sendJson(res, 500, { error: `Something went wrong on our side. Please try again, or contact ${config.helpContact}.` });
      }
    }
  });
  server.db = db;
  return server;
}

if (require.main === module) {
  const server = createServer();
  if (!config.disableTimers) {
    email.startWorker(server.db);
    jobs.start(server.db);
  }
  server.listen(config.port, () => {
    console.log(`Conference scheduler running at ${config.baseUrl} (port ${config.port}, mail: ${config.mailTransport})`);
    if (!config.adminEmails.length) console.log('Note: set ADMIN_EMAILS to let someone sign in as admin.');
  });
  const shutdown = () => server.close(() => { server.db.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, HttpError };
