'use strict';
// Reads the four uploads (.csv or .xlsx), validates every row, and imports only
// when there are zero errors. Re-imports update records in place (matched on
// SIS ID, teacher email, parent email) and never delete bookings.

const ExcelJS = require('exceljs');
const { parseCsv } = require('./csv');
const { tx, nowIso, audit } = require('./db');
const { isValidYMD } = require('./tz');

const FILES = {
  students: {
    label: 'Upload 1: Students and parents',
    columns: {
      sis_id: { names: ['sis id', 'sisid', 'student id', 'sis'], required: true },
      first_name: { names: ['first name', 'firstname', 'student first name'], required: true },
      last_name: { names: ['last name', 'lastname', 'student last name'], required: true },
      dob: { names: ['date of birth', 'dob', 'birth date', 'birthdate'], required: true },
      p1_name: { names: ['primary parent name'], required: true },
      p1_email: { names: ['primary parent email'], required: true },
      p2_name: { names: ['secondary parent name'], required: false },
      p2_email: { names: ['secondary parent email'], required: false },
    },
  },
  schedules: {
    label: 'Upload 2: Student schedules',
    columns: {
      sis_id: { names: ['sis id', 'sisid', 'student id', 'sis'], required: true },
      section: { names: ['course section', 'section', 'coursesection'], required: true },
    },
  },
  teachers: {
    label: 'Upload 3: Teacher sections',
    columns: {
      name: { names: ['teacher name', 'teacher'], required: true },
      email: { names: ['teacher email'], required: true },
      section: { names: ['course section', 'section', 'coursesection'], required: true },
      room: { names: ['room number', 'room', 'room no', 'room #'], required: true },
    },
  },
  supports: {
    label: 'Upload 4: Special education and ELL support',
    columns: {
      sis_id: { names: ['sis id', 'sisid', 'student id', 'sis'], required: true },
      type: { names: ['support type', 'type'], required: true },
      email: { names: ['support teacher email', 'teacher email'], required: true },
      section: { names: ['co-taught section', 'cotaught section', 'co taught section', 'section', 'course section'], required: true },
    },
  },
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Excel date cells arrive as midnight UTC.
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellToString(v.result);
    if ('text' in v) return cellToString(v.text);
    if ('error' in v) return '';
    return '';
  }
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return String(v);
}

async function readTable(file) {
  // file: { name, data: Buffer }
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return parseCsv(file.data.toString('utf8'));
  }
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.data);
    const ws = wb.worksheets.find((w) => w.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const out = [];
      for (let c = 1; c <= ws.columnCount; c++) out.push(cellToString(row.getCell(c).value));
      rows.push(out);
    }
    return rows;
  }
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported. In Excel, use File > Save As > .xlsx or .csv.');
  throw new Error('Unsupported file type. Upload a .csv or .xlsx file.');
}

// Finds the header row (within the first 10 rows, to allow a report title above
// it) and maps each needed column to its index.
function mapColumns(rows, spec) {
  const wanted = Object.entries(spec.columns);
  let firstMissing = null;
  for (let h = 0; h < Math.min(rows.length, 10); h++) {
    const header = rows[h].map(norm);
    const map = {};
    for (const [key, col] of wanted) {
      const idx = header.findIndex((cell) => col.names.some((n) => norm(n) === cell));
      if (idx >= 0) map[key] = idx;
    }
    const missing = wanted.filter(([k, c]) => c.required && !(k in map)).map(([, c]) => c.names[0]);
    if (missing.length === 0) return { headerRow: h, map, missing: [] };
    if (h === 0) firstMissing = missing;
  }
  return { headerRow: -1, map: null, missing: firstMissing || [] };
}

function parseDob(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'Date of Birth is missing' };
  let y, m, d;
  let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]00:00(?::00(?:\.0+)?)?Z?)?$/.exec(s);
  if (mt) { [y, m, d] = [+mt[1], +mt[2], +mt[3]]; }
  else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { [m, d, y] = [+mt[1], +mt[2], +mt[3]]; }
  else return { error: `Date of Birth "${s}" is not a date (use YYYY-MM-DD or MM/DD/YYYY)` };
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!isValidYMD(iso)) return { error: `Date of Birth "${s}" is not a real date` };
  if (iso > new Date().toISOString().slice(0, 10)) return { error: `Date of Birth "${s}" is in the future` };
  if (y < 1980) return { error: `Date of Birth "${s}" looks wrong (before 1980)` };
  return { value: iso };
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().normalize('NFC');
}

function cleanEmail(s) {
  return String(s || '').trim().replace(/^mailto:/i, '').toLowerCase();
}

function cleanCode(s) {
  return String(s || '').trim().toUpperCase();
}

async function validate(files, db) {
  const errors = [];
  const warnings = [];
  const err = (file, row, msg) => errors.push({ file: FILES[file].label, row, message: msg });
  const warn = (file, row, msg) => warnings.push({ file: FILES[file].label, row, message: msg });
  const tables = {};

  for (const key of Object.keys(FILES)) {
    const f = files[key];
    if (!f) {
      if (key === 'supports') {
        warn(key, null, 'No special education/ELL list was uploaded, so no co-taught meetings will be paired. Upload a file with just the header row if there are none.');
        tables[key] = [];
        continue;
      }
      err(key, null, 'This file is required.');
      continue;
    }
    let rows;
    try {
      rows = await readTable(f);
    } catch (e) {
      err(key, null, `Could not read "${f.name}": ${e.message}`);
      continue;
    }
    const { headerRow, map, missing } = mapColumns(rows, FILES[key]);
    if (headerRow < 0) {
      err(key, 1, `Missing column(s): ${missing.map((m) => `"${m}"`).join(', ')}. Check the header row of "${f.name}".`);
      continue;
    }
    const out = [];
    for (let r = headerRow + 1; r < rows.length; r++) {
      const raw = rows[r];
      if (!raw || raw.every((c) => String(c || '').trim() === '')) continue;
      const rec = { _row: r + 1 };
      for (const [k, idx] of Object.entries(map)) rec[k] = String(raw[idx] ?? '').trim();
      out.push(rec);
    }
    tables[key] = out;
  }
  if (errors.length) return { errors, warnings, data: null };

  // ---- Upload 3: teachers and sections ----
  const teachers = new Map(); // email -> { email, name, rooms: Map(room -> count), firstRoom }
  const sections = new Map(); // code -> Map(teacherEmail -> room)
  for (const r of tables.teachers) {
    const name = cleanName(r.name);
    const email = cleanEmail(r.email);
    const code = cleanCode(r.section);
    const room = cleanName(r.room);
    let bad = false;
    if (!name) { err('teachers', r._row, 'Teacher Name is missing'); bad = true; }
    if (!email) { err('teachers', r._row, 'Teacher Email is missing'); bad = true; }
    else if (!EMAIL_RE.test(email)) { err('teachers', r._row, `Teacher Email "${r.email}" is not a valid email address`); bad = true; }
    if (!code) { err('teachers', r._row, 'Course Section is missing'); bad = true; }
    if (!room) { err('teachers', r._row, `Room Number is missing${name ? ` for ${name}` : ''}`); bad = true; }
    if (bad) continue;
    const t = teachers.get(email);
    if (!t) teachers.set(email, { email, name, rooms: new Map([[room, 1]]), firstRoom: room, row: r._row });
    else {
      if (t.name !== name) warn('teachers', r._row, `${email} is listed as "${t.name}" (row ${t.row}) and "${name}". Using "${t.name}".`);
      t.rooms.set(room, (t.rooms.get(room) || 0) + 1);
    }
    if (!sections.has(code)) sections.set(code, new Map());
    const sec = sections.get(code);
    if (sec.has(email)) warn('teachers', r._row, `Duplicate row: ${email} teaching ${code}. Ignored.`);
    else sec.set(email, room);
  }
  for (const t of teachers.values()) {
    if (t.rooms.size > 1) {
      warn('teachers', null, `${t.name} is listed in several rooms (${[...t.rooms.keys()].join(', ')}). Conferences will use room ${t.firstRoom}; you can change it after import.`);
    }
    t.room = t.firstRoom;
  }

  // ---- Upload 1: students and parents ----
  const students = new Map(); // sis -> record
  const guardianNames = new Map(); // email -> { name, row }
  for (const r of tables.students) {
    const sis = String(r.sis_id || '').trim();
    let bad = false;
    if (!sis) { err('students', r._row, 'SIS ID is missing'); continue; }
    if (students.has(sis)) { err('students', r._row, `Duplicate SIS ID ${sis} (also on row ${students.get(sis)._row})`); continue; }
    const first = cleanName(r.first_name);
    const last = cleanName(r.last_name);
    if (!first) { err('students', r._row, `First Name is missing (SIS ID ${sis})`); bad = true; }
    if (!last) { err('students', r._row, `Last Name is missing (SIS ID ${sis})`); bad = true; }
    const dob = parseDob(r.dob);
    if (dob.error) { err('students', r._row, `${dob.error} (SIS ID ${sis})`); bad = true; }
    const p1n = cleanName(r.p1_name);
    const p1e = cleanEmail(r.p1_email);
    if (!p1n) { err('students', r._row, `Primary Parent Name is missing (SIS ID ${sis})`); bad = true; }
    if (!p1e) { err('students', r._row, `Primary Parent Email is missing (SIS ID ${sis})`); bad = true; }
    else if (!EMAIL_RE.test(p1e)) { err('students', r._row, `Primary Parent Email "${r.p1_email}" is not a valid email address (SIS ID ${sis})`); bad = true; }
    const p2n = cleanName(r.p2_name);
    let p2e = cleanEmail(r.p2_email);
    if (p2e && !EMAIL_RE.test(p2e)) { err('students', r._row, `Secondary Parent Email "${r.p2_email}" is not a valid email address (SIS ID ${sis})`); bad = true; }
    if (p2e && !p2n) { err('students', r._row, `Secondary Parent Email is filled in but Secondary Parent Name is missing (SIS ID ${sis})`); bad = true; }
    if (!p2e && p2n) warn('students', r._row, `Secondary parent ${p2n} has no email, so they cannot log in (SIS ID ${sis}).`);
    if (p2e && p2e === p1e) { warn('students', r._row, `Primary and secondary parent have the same email (SIS ID ${sis}); treated as one parent.`); p2e = ''; }
    const rec = { _row: r._row, sis, first, last, dob: dob.value, guardians: [] };
    students.set(sis, rec);
    if (bad) { rec.bad = true; continue; }
    for (const [email, name, relation] of [[p1e, p1n, 'primary'], [p2e, p2n, 'secondary']]) {
      if (!email) continue;
      const g = guardianNames.get(email);
      if (!g) guardianNames.set(email, { name, row: r._row });
      else if (g.name.toLowerCase() !== name.toLowerCase()) {
        warn('students', r._row, `${email} is named "${g.name}" on row ${g.row} and "${name}" here. Using "${g.name}".`);
      }
      rec.guardians.push({ email, relation });
    }
  }

  // ---- Upload 2: student schedules ----
  const enrollments = new Map(); // sis -> Set(code)
  for (const r of tables.schedules) {
    const sis = String(r.sis_id || '').trim();
    const code = cleanCode(r.section);
    if (!sis) { err('schedules', r._row, 'SIS ID is missing'); continue; }
    if (!code) { err('schedules', r._row, `Course Section is missing (SIS ID ${sis})`); continue; }
    if (!students.has(sis)) { err('schedules', r._row, `SIS ID ${sis} is not in Upload 1`); continue; }
    if (!sections.has(code)) { err('schedules', r._row, `Course Section ${code} has no teacher in Upload 3 (SIS ID ${sis})`); continue; }
    if (!enrollments.has(sis)) enrollments.set(sis, new Set());
    const set = enrollments.get(sis);
    if (set.has(code)) warn('schedules', r._row, `Duplicate row: SIS ID ${sis} in ${code}. Ignored.`);
    set.add(code);
  }
  for (const s of students.values()) {
    if (!s.bad && !enrollments.has(s.sis)) warn('students', s._row, `${s.first} ${s.last} (SIS ID ${s.sis}) has no sections in Upload 2, so their parents will see no teachers.`);
  }

  // ---- Upload 4: special education and ELL ----
  const supports = [];
  const seenSupport = new Set();
  for (const r of tables.supports) {
    const sis = String(r.sis_id || '').trim();
    const type = String(r.type || '').trim().toUpperCase();
    const email = cleanEmail(r.email);
    const code = cleanCode(r.section);
    let bad = false;
    if (!sis) { err('supports', r._row, 'SIS ID is missing'); continue; }
    if (!students.has(sis)) { err('supports', r._row, `SIS ID ${sis} is not in Upload 1`); bad = true; }
    if (type !== 'SPED' && type !== 'ELL') { err('supports', r._row, `Support Type must be SPED or ELL, not "${r.type}" (SIS ID ${sis})`); bad = true; }
    if (!email) { err('supports', r._row, `Support Teacher Email is missing (SIS ID ${sis})`); bad = true; }
    else if (!teachers.has(email)) { err('supports', r._row, `Support teacher ${email} is not in Upload 3. Add them there with a room number (SIS ID ${sis})`); bad = true; }
    if (!code) { err('supports', r._row, `Co-taught Section is missing (SIS ID ${sis})`); bad = true; }
    else if (!sections.has(code)) { err('supports', r._row, `Co-taught Section ${code} is not in Upload 3 (SIS ID ${sis})`); bad = true; }
    else if (students.has(sis) && !(enrollments.get(sis) || new Set()).has(code)) {
      err('supports', r._row, `SIS ID ${sis} is not enrolled in ${code} in Upload 2`); bad = true;
    }
    if (bad) continue;
    const others = [...sections.get(code).keys()].filter((e) => e !== email);
    if (others.length === 0) { err('supports', r._row, `${email} is the only teacher of ${code}, so there is no one to co-teach with (SIS ID ${sis})`); continue; }
    const k = `${sis}|${email}|${code}`;
    if (seenSupport.has(k)) { warn('supports', r._row, `Duplicate row for SIS ID ${sis}, ${email}, ${code}. Ignored.`); continue; }
    seenSupport.add(k);
    supports.push({ sis, type, email, code });
  }

  // ---- Compare against what is already in the database ----
  if (db && errors.length === 0) {
    const ev = db.prepare('SELECT id FROM events WHERE is_current = 1').get();
    if (ev) {
      const bookedStudents = db.prepare(`SELECT s.sis_id, s.first_name, s.last_name, COUNT(*) n FROM bookings b
        JOIN students s ON s.id = b.student_id WHERE b.event_id = ? AND b.status = 'active' GROUP BY s.id`).all(ev.id);
      for (const s of bookedStudents) {
        if (!students.has(s.sis_id)) warn('students', null, `${s.first_name} ${s.last_name} (SIS ID ${s.sis_id}) is not in this upload but has ${s.n} booked conference(s). The bookings are kept; review or cancel them from the admin page.`);
      }
      const bookedTeachers = db.prepare(`SELECT t.email, t.name, COUNT(DISTINCT bs.booking_id) n FROM booking_slots bs
        JOIN teachers t ON t.id = bs.teacher_id JOIN slots sl ON sl.id = bs.slot_id WHERE sl.event_id = ? GROUP BY t.id`).all(ev.id);
      for (const t of bookedTeachers) {
        if (!teachers.has(t.email)) warn('teachers', null, `${t.name} (${t.email}) is not in this upload but has ${t.n} booked conference(s). Use "Teacher unavailable" on the admin page if they should be cancelled.`);
      }
    }
  }

  const summary = {
    students: students.size,
    parents: guardianNames.size,
    teachers: teachers.size,
    sections: sections.size,
    enrollments: [...enrollments.values()].reduce((a, s) => a + s.size, 0),
    supports: supports.length,
  };
  return { errors, warnings, summary, data: errors.length ? null : { teachers, sections, students, guardianNames, enrollments, supports } };
}

function importData(db, data, actor, ensureSlotsFn) {
  return tx(db, () => {
    // Teachers: upsert by email. Teachers missing from the upload are deactivated, never deleted.
    db.prepare('UPDATE teachers SET active = 0').run();
    const upT = db.prepare(`INSERT INTO teachers (email, name, room, active) VALUES (?, ?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, room = CASE WHEN teachers.room_locked = 1 THEN teachers.room ELSE excluded.room END, active = 1`);
    for (const t of data.teachers.values()) upT.run(t.email, t.name, t.room);
    const tid = new Map(db.prepare('SELECT id, email FROM teachers').all().map((r) => [r.email, r.id]));

    db.prepare('DELETE FROM sections').run();
    const insSec = db.prepare('INSERT INTO sections (code, teacher_id, room) VALUES (?, ?, ?)');
    for (const [code, m] of data.sections) for (const [email, room] of m) insSec.run(code, tid.get(email), room);

    db.prepare('UPDATE students SET active = 0').run();
    const upS = db.prepare(`INSERT INTO students (sis_id, first_name, last_name, dob, active) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(sis_id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, dob = excluded.dob, active = 1`);
    for (const s of data.students.values()) upS.run(s.sis, s.first, s.last, s.dob);
    const sid = new Map(db.prepare('SELECT id, sis_id FROM students').all().map((r) => [r.sis_id, r.id]));

    db.prepare('UPDATE guardians SET active = 0').run();
    const upG = db.prepare(`INSERT INTO guardians (email, name, active) VALUES (?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, active = 1`);
    for (const [email, g] of data.guardianNames) upG.run(email, g.name);
    const gid = new Map(db.prepare('SELECT id, email FROM guardians').all().map((r) => [r.email, r.id]));

    db.prepare('DELETE FROM student_guardians').run();
    const insSG = db.prepare('INSERT OR IGNORE INTO student_guardians (student_id, guardian_id, relation) VALUES (?, ?, ?)');
    for (const s of data.students.values()) for (const g of s.guardians) insSG.run(sid.get(s.sis), gid.get(g.email), g.relation);

    db.prepare('DELETE FROM enrollments').run();
    const insE = db.prepare('INSERT INTO enrollments (student_id, section_code) VALUES (?, ?)');
    for (const [sis, set] of data.enrollments) for (const code of set) insE.run(sid.get(sis), code);

    db.prepare('DELETE FROM supports').run();
    const insSup = db.prepare('INSERT INTO supports (student_id, support_type, teacher_id, section_code) VALUES (?, ?, ?, ?)');
    for (const s of data.supports) insSup.run(sid.get(s.sis), s.type, tid.get(s.email), s.code);

    const ev = db.prepare('SELECT id FROM events WHERE is_current = 1').get();
    if (ev && ensureSlotsFn) ensureSlotsFn(db, ev.id);

    audit(db, actor, 'import', {
      students: data.students.size, teachers: data.teachers.size, sections: data.sections.size, supports: data.supports.length,
    });
    return { importedAt: nowIso() };
  });
}

module.exports = { validate, importData, readTable, parseDob, FILES };
