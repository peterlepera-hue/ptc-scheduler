'use strict';
// Starts the app with a fake school so you can click around safely.
//   npm run demo            -> http://localhost:3000
// Sign-in codes are printed in this terminal (emails are not sent in demo mode).
// The demo database lives in ./demo-data and is rebuilt every time.

const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'demo-data');
fs.rmSync(dir, { recursive: true, force: true });
process.env.DATA_DIR = dir;
process.env.DEV_SHOW_CODES = '1';
process.env.DEMO_MODE = '1';
process.env.MAIL_TRANSPORT = 'outbox';
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'office@demo.school';
process.env.SCHOOL_NAME = process.env.SCHOOL_NAME || 'Lincoln Middle School';
process.env.HELP_CONTACT = process.env.HELP_CONTACT || 'the front office at (555) 010-0100';

const { createServer } = require('../src/server');
const importer = require('../src/importer');
const events = require('../src/events');
const booking = require('../src/booking');
const email = require('../src/email');
const jobs = require('../src/jobs');
const tz = require('../src/tz');
const config = require('../src/config');

const FIRST = ['Maya', 'Leo', 'Ana', 'Sam', 'Alex', 'Jamie', 'José', 'Priya', 'Noah', 'Emma', 'Liam', 'Ava', 'Mateo', 'Zoe', 'Ethan', 'Chloe', 'Omar', 'Lily', 'Kenji', 'Sofia', 'Diego', 'Grace', 'Aiden', 'Mia', 'Yusuf'];
const LAST = ['Thompson', 'Ruiz', 'Nguyễn', 'Okafor', 'García-López', 'Patel', 'Kim', 'Johnson', 'Cohen', 'Williams', 'Haddad', 'Tanaka', 'Silva', 'O\'Brien', 'Novak'];
const TEACHERS = [
  ['Mr. Patel', 'rpatel', 'MATH', '214'], ['Ms. Green', 'green', 'ENG', '110'], ['Mr. Brown', 'brown', 'SCI', '301'],
  ['Ms. White', 'white', 'ART', '5'], ['Mr. Gray', 'gray', 'MUS', '7'], ['Ms. Kim', 'kim', 'SOC', '102'],
  ['Mr. Diaz', 'diaz', 'SPAN', '104'], ['Ms. Fox', 'fox', 'PE', 'Gym'],
];

function csvFile(name, rows) {
  const text = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  return { name, data: Buffer.from(text) };
}

async function main() {
  const server = createServer();
  const db = server.db;

  const students = [['SIS ID', 'First Name', 'Last Name', 'Date of Birth', 'Primary Parent Name', 'Primary Parent Email', 'Secondary Parent Name', 'Secondary Parent Email']];
  const schedules = [['SIS ID', 'Course Section']];
  const teachers = [['Teacher Name', 'Teacher Email', 'Course Section', 'Room Number']];
  for (const [name, user, subj, room] of TEACHERS) for (const g of [6, 7]) teachers.push([name, `${user}@demo.school`, `${subj}${g}-01`, room]);
  teachers.push(['Ms. Lee', 'jlee@demo.school', 'RES-01', '120']);
  // Family 1: Andrea Ruiz with Maya (grade 6) and Leo (grade 7); David Thompson is Maya's second guardian.
  students.push(['1001', 'Maya', 'Thompson', '2014-03-22', 'Andrea Ruiz', 'parent@demo.school', 'David Thompson', 'david@demo.school']);
  students.push(['1002', 'Leo', 'Ruiz', '2013-07-01', 'Andrea Ruiz', 'parent@demo.school', '', '']);
  for (const s of ['MATH6-01', 'ENG6-01', 'SCI6-01', 'ART6-01', 'MUS6-01', 'PE6-01']) schedules.push(['1001', s]);
  for (const s of ['MATH7-01', 'ENG7-01', 'SOC7-01', 'SPAN7-01', 'ART7-01']) schedules.push(['1002', s]);
  for (let i = 0; i < 60; i++) {
    const sis = String(2000 + i);
    const g = i % 2 ? 7 : 6;
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const dob = `${g === 6 ? 2014 : 2013}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
    students.push([sis, first, last, dob, `Parent of ${first} ${last}`, `family${i}@demo.school`, '', '']);
    for (const [, , subj] of TEACHERS.slice(0, 4 + (i % 4))) schedules.push([sis, `${subj}${g}-01`]);
  }
  const supports = [['SIS ID', 'Support Type', 'Support Teacher Email', 'Co-taught Section'], ['1001', 'SPED', 'jlee@demo.school', 'ENG6-01']];

  const report = await importer.validate({
    students: csvFile('students.csv', students), schedules: csvFile('schedules.csv', schedules),
    teachers: csvFile('teachers.csv', teachers), supports: csvFile('supports.csv', supports),
  }, db);
  if (report.errors.length) throw new Error(JSON.stringify(report.errors, null, 2));
  importer.importData(db, report.data, 'demo', events.ensureSlots);

  const day = tz.localDate(new Date(Date.now() + 9 * 86400e3).toISOString());
  const day2 = tz.localDate(new Date(Date.now() + 10 * 86400e3).toISOString());
  const r = events.saveEvent(db, {
    name: 'Fall Parent-Teacher Conferences', slot_minutes: 10,
    days: [{ day, start_time: '15:00', end_time: '18:00' }, { day: day2, start_time: '08:00', end_time: '10:00' }],
    booking_opens_at: tz.isoToLocalInput(new Date(Date.now() - 86400e3).toISOString()),
    booking_closes_at: tz.isoToLocalInput(new Date(Date.now() + 7 * 86400e3).toISOString()),
    cutoff_hours: 6, max_per_child: 4, reminder_times: events.defaultReminders([{ day }, { day: day2 }]),
    location_note: 'Enter through the main doors on Elm Street. Sign in at the front desk.',
  }, 'demo');
  if (r.errors) throw new Error(r.errors.join(' '));

  // Fill some time so the screens look lived in: Mr. Patel is nearly full.
  const ev = events.currentEvent(db);
  const slots = db.prepare('SELECT DISTINCT starts_at FROM slots WHERE event_id = ? ORDER BY starts_at').all(ev.id).map((x) => x.starts_at);
  const patel = db.prepare("SELECT id FROM teachers WHERE email = 'rpatel@demo.school'").get().id;
  const fams = db.prepare("SELECT g.id gid, s.id sid FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id WHERE g.email LIKE 'family%' ORDER BY s.sis_id").all();
  let k = 0;
  for (const f of fams) {
    const tids = db.prepare(`SELECT DISTINCT sec.teacher_id FROM enrollments e JOIN sections sec ON sec.code = e.section_code WHERE e.student_id = ?`).all(f.sid).map((x) => x.teacher_id);
    for (const tid of tids.slice(0, 2)) {
      const at = slots[(k * 5) % slots.length];
      k++;
      booking.book(db, { eventId: ev.id, guardianId: f.gid, teacherId: tid === patel ? patel : tid, startsAt: at, studentId: f.sid, note: k % 4 ? '' : 'Would like to talk about homework', actor: 'demo', role: 'admin' });
    }
  }
  for (let i = 0; i < slots.length - 3; i++) {
    for (let j = 0; j < fams.length; j++) {
      const f = fams[(i * 3 + j) % fams.length];
      const r = booking.book(db, { eventId: ev.id, guardianId: f.gid, teacherId: patel, startsAt: slots[i], studentId: f.sid, note: '', actor: 'demo', role: 'admin' });
      if (r.ok || r.code === 'SLOT_TAKEN') break;
    }
  }
  db.exec("DELETE FROM emails; DELETE FROM audit_log WHERE actor = 'demo'");

  email.startWorker(db);
  jobs.start(db);
  server.listen(config.port, () => {
    console.log(`\nDemo running at http://localhost:${config.port}\n`);
    console.log('  Parent:  parent@demo.school + date of birth 2014-03-22 (Maya) or 2013-07-01 (Leo)');
    console.log('  Teacher: green@demo.school (staff sign in)');
    console.log('  Admin:   office@demo.school (staff sign in)');
    console.log('\nSign-in codes are printed below when requested.\n');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
