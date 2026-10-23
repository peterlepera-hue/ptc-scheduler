'use strict';
// Shared test fixtures: a small fake school, a server on a random port with a
// throwaway database, and a cookie-keeping HTTP client.

process.env.DISABLE_TIMERS = '1';
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'office@school.org';
process.env.SCHOOL_NAME = 'Test Middle School';
process.env.HELP_CONTACT = 'the front office (555-0100)';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const tz = require('../src/tz');

function csv(rows) {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}

const STUDENTS = [
  ['SIS ID', 'First Name', 'Last Name', 'Date of Birth', 'Primary Parent Name', 'Primary Parent Email', 'Secondary Parent Name', 'Secondary Parent Email'],
  ['1001', 'Maya', 'Thompson', '2014-03-22', 'Andrea Ruiz', 'aruiz@example.com', 'David Thompson', 'dthompson@example.com'],
  ['1002', 'Leo', 'Ruiz', '2016-07-01', 'Andrea Ruiz', 'ARuiz@Example.com', '', ''],
  ['1003', 'Ana', 'Nguyễn', '2014-05-05', 'Linh Nguyễn', 'linh@example.com', '', ''],
  ['1004', 'Sam', 'Okafor', '2015-01-10', 'Chidi Okafor', 'chidi@example.com', '', ''],
  ['1005', 'Alex', 'Okafor', '01/10/2015', 'Chidi Okafor', 'chidi@example.com', '', ''],
  ['1006', 'Jamie', 'Okafor', '2017-02-02', 'Chidi Okafor', 'chidi@example.com', '', ''],
  ['1007', 'José', 'García-López', '2014-09-09', 'María García-López', 'maria@example.com', '', ''],
];

const TEACHERS = [
  ['Teacher Name', 'Teacher Email', 'Course Section', 'Room Number'],
  ['Mr. Patel', 'rpatel@school.org', 'MATH6-03', '214'],
  ['Ms. Green', 'green@school.org', 'ENG6-02', '110'],
  ['Mr. Brown', 'brown@school.org', 'SCI6-01', '301'],
  ['Mr. Brown', 'brown@school.org', 'SCI4-01', '301'],
  ['Ms. White', 'white@school.org', 'ART-01', '5'],
  ['Ms. White', 'white@school.org', 'ART-02', '5'],
  ['Mr. Gray', 'gray@school.org', 'MUS-01', '7'],
  ['Ms. Kim', 'kim@school.org', 'READ4-01', '102'],
  ['Mr. Diaz', 'diaz@school.org', 'MATH4-01', '104'],
  ['Ms. Fox', 'fox@school.org', 'PE4-01', 'Gym'],
  ['Ms. Lee', 'jlee@school.org', 'RES-01', '120'],
];

const SCHEDULES = [
  ['SIS ID', 'Course Section'],
  ['1001', 'MATH6-03'], ['1001', 'ENG6-02'], ['1001', 'SCI6-01'], ['1001', 'ART-01'], ['1001', 'MUS-01'],
  ['1002', 'SCI4-01'], ['1002', 'ART-02'], ['1002', 'READ4-01'], ['1002', 'MATH4-01'], ['1002', 'PE4-01'],
  ['1003', 'ENG6-02'], ['1003', 'MATH6-03'],
  ['1004', 'MATH6-03'], ['1005', 'ENG6-02'], ['1006', 'PE4-01'],
  ['1007', 'MATH6-03'], ['1007', 'MATH6-03'],
];

const SUPPORTS = [
  ['SIS ID', 'Support Type', 'Support Teacher Email', 'Co-taught Section'],
  ['1003', 'SPED', 'jlee@school.org', 'ENG6-02'],
];

// Extra families who all need Mr. Patel, for the stampede tests.
function crowd(n) {
  const s = []; const e = [];
  for (let i = 0; i < n; i++) {
    const sis = String(5000 + i);
    s.push([sis, `Kid${i}`, `Crowd${i}`, '2014-06-15', `Parent ${i}`, `crowd${i}@example.com`, '', '']);
    e.push([sis, 'MATH6-03']);
  }
  return { s, e };
}

function fixtureFiles({ crowdSize = 0, mutate } = {}) {
  const c = crowd(crowdSize);
  const t = {
    students: [...STUDENTS.map((r) => [...r]), ...c.s],
    schedules: [...SCHEDULES.map((r) => [...r]), ...c.e],
    teachers: TEACHERS.map((r) => [...r]),
    supports: SUPPORTS.map((r) => [...r]),
  };
  if (mutate) mutate(t);
  const enc = (rows, name) => ({ name, data: Buffer.from(csv(rows)).toString('base64') });
  return {
    students: enc(t.students, 'students.csv'),
    schedules: enc(t.schedules, 'schedules.csv'),
    teachers: enc(t.teachers, 'teachers.csv'),
    supports: enc(t.supports, 'supports.csv'),
  };
}

function localDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return tz.localDate(d.toISOString());
}

function localInput(msFromNow) {
  return tz.isoToLocalInput(new Date(Date.now() + msFromNow).toISOString());
}

// An event 10 days out, 3:00-5:00pm, 10-minute slots (12 per teacher).
function eventInput(overrides = {}) {
  const day = localDay(10);
  return {
    name: 'Fall Conferences',
    slot_minutes: 10,
    days: [{ day, start_time: '15:00', end_time: '17:00' }],
    booking_opens_at: localInput(-3600e3),
    booking_closes_at: localInput(5 * 86400e3),
    cutoff_hours: 6,
    max_per_child: 4,
    reminder_times: [],
    location_note: 'Enter through the main doors on Elm St.',
    ...overrides,
  };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, p, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (method === 'POST') { h['content-type'] = h['content-type'] || 'application/json'; if (!('x-requested-with' in h)) h['x-requested-with'] = 'ptc'; }
    const res = await fetch(this.base + p, { method, headers: h, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  }
  get(p, o) { return this.req('GET', p, null, o); }
  post(p, b, o) { return this.req('POST', p, b, o); }
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptc-test-'));
  const server = createServer({ dbFile: path.join(dir, 'test.sqlite') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = server.db;
  const app = {
    base, db, server, dir,
    client: () => new Client(base),
    latestCode(email) {
      const e = db.prepare("SELECT text_body FROM emails WHERE kind = 'login_code' AND to_email = ? ORDER BY id DESC LIMIT 1").get(email);
      return e ? /code is (\d{6})/.exec(e.text_body)[1] : null;
    },
    clearLoginCodes(email) {
      // Lets a test log the same person in again without waiting out the resend delay.
      db.prepare("UPDATE login_codes SET created_at = '2000-01-01T00:00:00.000Z' WHERE email = ?").run(email);
    },
    async parent(email, dob) {
      const c = new Client(base);
      app.clearLoginCodes(email.toLowerCase());
      const a = await c.post('/api/parent/login', { email, dob });
      if (a.status !== 200) throw new Error(`parent login failed: ${a.text}`);
      const v = await c.post('/api/parent/verify', { email, code: app.latestCode(email.toLowerCase()) });
      if (v.status !== 200) throw new Error(`parent verify failed: ${v.text}`);
      return c;
    },
    async staff(email) {
      const c = new Client(base);
      app.clearLoginCodes(email);
      await c.post('/api/staff/login', { email });
      const code = app.latestCode(email);
      if (!code) throw new Error(`no staff code for ${email}`);
      const v = await c.post('/api/staff/verify', { email, code });
      if (v.status !== 200) throw new Error(`staff verify failed: ${v.text}`);
      return c;
    },
    async setup({ crowdSize = 0, event = {} } = {}) {
      const admin = await app.staff('office@school.org');
      const imp = await admin.post('/api/admin/upload/import', { files: fixtureFiles({ crowdSize }) });
      if (!imp.body || !imp.body.imported) throw new Error(`import failed: ${imp.text}`);
      const ev = await admin.post('/api/admin/event', eventInput(event));
      if (ev.status !== 200) throw new Error(`event failed: ${ev.text}`);
      return admin;
    },
    teacherId(email) { return db.prepare('SELECT id FROM teachers WHERE email = ?').get(email).id; },
    studentId(sis) { return db.prepare('SELECT id FROM students WHERE sis_id = ?').get(sis).id; },
    guardianId(email) { return db.prepare('SELECT id FROM guardians WHERE email = ?').get(email).id; },
    slotTimes() {
      return db.prepare('SELECT DISTINCT starts_at FROM slots ORDER BY starts_at').all().map((r) => r.starts_at);
    },
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

module.exports = { startApp, fixtureFiles, eventInput, localDay, localInput, csv, Client, STUDENTS, TEACHERS, SCHEDULES, SUPPORTS };
