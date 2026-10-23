'use strict';
// SQLite database: schema, triggers and a transaction helper.
//
// The rules that must never break are enforced here, by the database itself,
// so that even a bug in the application code cannot violate them:
//   * one booking per slot            -> booking_slots.slot_id is the PRIMARY KEY
//   * the per-child conference limit  -> trigger bookings_child_limit
//   * one meeting per family+teacher  -> unique index bookings_one_per_guardian_teacher
//   * a parent cannot be in two places at once -> trigger bookings_guardian_overlap
//   * blocked slots cannot be booked  -> trigger booking_slots_not_blocked

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  sis_id TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS guardians (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  email_status TEXT NOT NULL DEFAULT 'ok',
  email_status_detail TEXT
);

CREATE TABLE IF NOT EXISTS student_guardians (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('primary', 'secondary')),
  PRIMARY KEY (student_id, guardian_id)
);
CREATE INDEX IF NOT EXISTS student_guardians_guardian ON student_guardians(guardian_id);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT '',
  room_locked INTEGER NOT NULL DEFAULT 0, -- 1 = admin set the room; uploads keep it
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sections (
  code TEXT NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  room TEXT NOT NULL,
  PRIMARY KEY (code, teacher_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_code TEXT NOT NULL,
  PRIMARY KEY (student_id, section_code)
);

CREATE TABLE IF NOT EXISTS supports (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  support_type TEXT NOT NULL CHECK (support_type IN ('SPED', 'ELL')),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  section_code TEXT NOT NULL,
  PRIMARY KEY (student_id, teacher_id, section_code)
);

CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL CHECK (slot_minutes BETWEEN 5 AND 60),
  booking_opens_at TEXT NOT NULL,
  booking_closes_at TEXT NOT NULL,
  cutoff_hours REAL NOT NULL DEFAULT 6 CHECK (cutoff_hours >= 0),
  max_per_child INTEGER NOT NULL DEFAULT 4 CHECK (max_per_child >= 1),
  reminder_times TEXT NOT NULL DEFAULT '[]',
  location_note TEXT NOT NULL DEFAULT '',
  is_current INTEGER NOT NULL DEFAULT 0,
  open_email_sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_days (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  PRIMARY KEY (event_id, day)
);

CREATE TABLE IF NOT EXISTS child_limits (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  max_conferences INTEGER NOT NULL CHECK (max_conferences >= 0),
  PRIMARY KEY (event_id, student_id)
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  block_reason TEXT,
  UNIQUE (event_id, teacher_id, starts_at)
);
CREATE INDEX IF NOT EXISTS slots_event_start ON slots(event_id, starts_at);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  guardian_id INTEGER NOT NULL REFERENCES guardians(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS bookings_student ON bookings(event_id, student_id, status);
CREATE INDEX IF NOT EXISTS bookings_guardian ON bookings(event_id, guardian_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_per_guardian_teacher
  ON bookings(event_id, guardian_id, teacher_id) WHERE status = 'active';

-- slot_id is the primary key: a slot can belong to at most one booking, ever, at a time.
CREATE TABLE IF NOT EXISTS booking_slots (
  slot_id INTEGER PRIMARY KEY REFERENCES slots(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  role TEXT NOT NULL CHECK (role IN ('primary', 'co'))
);
CREATE INDEX IF NOT EXISTS booking_slots_booking ON booking_slots(booking_id);

CREATE TABLE IF NOT EXISTS booking_students (
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  PRIMARY KEY (booking_id, student_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  guardian_id INTEGER NOT NULL REFERENCES guardians(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'scheduled')),
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS attempt_teachers (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  PRIMARY KEY (attempt_id, teacher_id)
);

CREATE TABLE IF NOT EXISTS login_failures (
  email TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'staff')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'staff')),
  email TEXT NOT NULL,
  guardian_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  ics TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'bounced')),
  tries INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,
  last_error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS emails_queue ON emails(status, next_try_at);

CREATE TABLE IF NOT EXISTS jobs_done (key TEXT PRIMARY KEY, done_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);

-- ---------- Safety-net triggers ----------

CREATE TRIGGER IF NOT EXISTS bookings_child_limit
BEFORE INSERT ON bookings
WHEN NEW.status = 'active' AND (
  SELECT COUNT(*) FROM bookings b
  WHERE b.event_id = NEW.event_id AND b.student_id = NEW.student_id AND b.status = 'active'
) >= COALESCE(
  (SELECT max_conferences FROM child_limits WHERE event_id = NEW.event_id AND student_id = NEW.student_id),
  (SELECT max_per_child FROM events WHERE id = NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'LIMIT_REACHED');
END;

CREATE TRIGGER IF NOT EXISTS bookings_guardian_overlap
BEFORE INSERT ON bookings
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.event_id = NEW.event_id AND b.guardian_id = NEW.guardian_id AND b.status = 'active'
    AND b.starts_at < NEW.ends_at AND NEW.starts_at < b.ends_at
)
BEGIN
  SELECT RAISE(ABORT, 'TIME_CONFLICT');
END;

-- A booking can only go from active to cancelled. It never changes child,
-- parent, teacher or time; a "change" is a cancel plus a new booking.
CREATE TRIGGER IF NOT EXISTS bookings_immutable
BEFORE UPDATE ON bookings
WHEN NEW.status <> OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'cancelled')
  OR NEW.student_id <> OLD.student_id OR NEW.guardian_id <> OLD.guardian_id
  OR NEW.teacher_id <> OLD.teacher_id OR NEW.starts_at <> OLD.starts_at OR NEW.event_id <> OLD.event_id
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS booking_slots_not_blocked
BEFORE INSERT ON booking_slots
WHEN (SELECT status FROM slots WHERE id = NEW.slot_id) IS NOT 'open'
  OR (SELECT status FROM bookings WHERE id = NEW.booking_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'SLOT_UNAVAILABLE');
END;

CREATE TRIGGER IF NOT EXISTS slots_no_block_when_booked
BEFORE UPDATE OF status ON slots
WHEN NEW.status = 'blocked' AND EXISTS (SELECT 1 FROM booking_slots WHERE slot_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'SLOT_BOOKED');
END;

CREATE TRIGGER IF NOT EXISTS slots_no_delete_when_booked
BEFORE DELETE ON slots
WHEN EXISTS (SELECT 1 FROM booking_slots WHERE slot_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'SLOT_BOOKED');
END;
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside BEGIN IMMEDIATE ... COMMIT. IMMEDIATE takes the write lock up
// front, so two processes can never both read "slot is free" and then both write.
// Nested calls join the outer transaction. We track this ourselves because
// DatabaseSync#isTransaction only exists in Node 22.16 and later.
const openTx = new WeakSet();
function tx(db, fn) {
  if (openTx.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  openTx.add(db);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    openTx.delete(db);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function audit(db, actor, action, details = {}) {
  db.prepare('INSERT INTO audit_log (at, actor, action, details) VALUES (?, ?, ?, ?)')
    .run(nowIso(), actor, action, JSON.stringify(details));
}

function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

module.exports = { open, tx, nowIso, audit, getMeta, setMeta };
