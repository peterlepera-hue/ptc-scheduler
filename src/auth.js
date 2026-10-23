'use strict';
// Sign-in for parents (email + child's date of birth + emailed 6-digit code)
// and staff (school email + emailed 6-digit code), sessions, and lockouts.

const crypto = require('node:crypto');
const config = require('./config');
const { nowIso, getMeta, setMeta, tx, audit } = require('./db');
const email = require('./email');

const CODE_TTL_MIN = 10;
const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MIN = 15;
const RESEND_SECONDS = 30;

let secret = null;
function getSecret(db) {
  if (secret) return secret;
  secret = config.sessionSecret || getMeta(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setMeta(db, 'session_secret', secret);
  }
  return secret;
}

function hmac(db, s) {
  return crypto.createHmac('sha256', getSecret(db)).update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function lockKey(kind, e) {
  return `${kind}:${e}`;
}

function lockedUntil(db, key) {
  const r = db.prepare('SELECT locked_until FROM login_failures WHERE email = ?').get(key);
  return r && r.locked_until && r.locked_until > nowIso() ? r.locked_until : null;
}

function recordFailure(db, key) {
  const r = db.prepare('SELECT failures, locked_until FROM login_failures WHERE email = ?').get(key);
  // A lock that has expired starts a fresh count.
  const failures = (r && !(r.locked_until && r.locked_until <= nowIso()) ? r.failures : 0) + 1;
  const lock = failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MIN * 60e3).toISOString() : null;
  db.prepare(`INSERT INTO login_failures (email, failures, locked_until) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`).run(key, lock ? 0 : failures, lock);
  return lock;
}

function clearFailures(db, key) {
  db.prepare('DELETE FROM login_failures WHERE email = ?').run(key);
}

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function issueCode(db, kind, to) {
  const recent = db.prepare('SELECT created_at FROM login_codes WHERE kind = ? AND email = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(kind, to);
  if (recent && Date.parse(recent.created_at) > Date.now() - RESEND_SECONDS * 1000) return null; // a code was just sent
  const code = newCode();
  db.prepare('UPDATE login_codes SET used = 1 WHERE kind = ? AND email = ? AND used = 0').run(kind, to);
  db.prepare('INSERT INTO login_codes (kind, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, to, hmac(db, `${kind}:${to}:${code}`), new Date(Date.now() + CODE_TTL_MIN * 60e3).toISOString(), nowIso());
  email.sendLoginCode(db, to, code);
  return code;
}

const LOCKED_MSG = `Too many attempts. Please wait ${LOCK_MIN} minutes and try again, or contact ${config.helpContact}.`;
const NO_MATCH_MSG = `We couldn't find a match. Check the email address and date of birth, or contact ${config.helpContact}.`;

// Step 1 for parents: email + a child's date of birth.
function parentStart(db, rawEmail, dob) {
  const e = normEmail(rawEmail);
  const key = lockKey('parent', e);
  return tx(db, () => {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob || ''))) return { ok: false, code: 'NO_MATCH', message: NO_MATCH_MSG };
    if (lockedUntil(db, key)) return { ok: false, code: 'LOCKED', message: LOCKED_MSG };
    const g = db.prepare(`SELECT g.id FROM guardians g
      JOIN student_guardians sg ON sg.guardian_id = g.id
      JOIN students s ON s.id = sg.student_id AND s.active = 1
      WHERE g.email = ? AND g.active = 1 AND s.dob = ? LIMIT 1`).get(e, dob);
    if (!g) {
      const lock = recordFailure(db, key);
      return lock ? { ok: false, code: 'LOCKED', message: LOCKED_MSG } : { ok: false, code: 'NO_MATCH', message: NO_MATCH_MSG };
    }
    const code = issueCode(db, 'parent', e);
    return config.demoMode && code ? { ok: true, demoCode: code } : { ok: true };
  });
}

function verifyCode(db, kind, e, code) {
  const key = lockKey(kind, e);
  if (lockedUntil(db, key)) return { ok: false, code: 'LOCKED', message: LOCKED_MSG };
  const row = db.prepare('SELECT * FROM login_codes WHERE kind = ? AND email = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(kind, e);
  const clean = String(code || '').replace(/\D/g, '');
  const valid = row && row.expires_at > nowIso() && row.attempts < MAX_FAILURES && clean.length === 6
    && safeEqual(row.code_hash, hmac(db, `${kind}:${e}:${clean}`));
  if (!valid) {
    if (row) {
      db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      if (row.attempts + 1 >= MAX_FAILURES) db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
    }
    const lock = recordFailure(db, key);
    if (lock) return { ok: false, code: 'LOCKED', message: LOCKED_MSG };
    const expired = row && row.expires_at <= nowIso();
    return { ok: false, code: 'BAD_CODE', message: expired ? 'That code has expired. Go back and request a new one.' : 'That code is not right. Check the latest email from us and try again.' };
  }
  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  clearFailures(db, key);
  return { ok: true };
}

function createSession(db, kind, e, guardianId = null) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, kind, email, guardian_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hmac(db, token), kind, e, guardianId, nowIso(), new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString());
  return token;
}

function parentVerify(db, rawEmail, code) {
  const e = normEmail(rawEmail);
  return tx(db, () => {
    const r = verifyCode(db, 'parent', e, code);
    if (!r.ok) return r;
    const g = db.prepare('SELECT id FROM guardians WHERE email = ? AND active = 1').get(e);
    if (!g) return { ok: false, code: 'NO_MATCH', message: NO_MATCH_MSG };
    audit(db, `parent:${e}`, 'login', {});
    return { ok: true, token: createSession(db, 'parent', e, g.id) };
  });
}

function isAdminEmail(db, e) {
  return config.adminEmails.includes(e) || Boolean(db.prepare('SELECT 1 FROM admins WHERE email = ?').get(e));
}

function staffStart(db, rawEmail) {
  const e = normEmail(rawEmail);
  const key = lockKey('staff', e);
  return tx(db, () => {
    // Same answer whether or not the address is on staff, so it can't be used to probe.
    if (!e || lockedUntil(db, key)) return { ok: true };
    const teacher = db.prepare('SELECT id FROM teachers WHERE email = ? AND active = 1').get(e);
    if (!teacher && !isAdminEmail(db, e)) { recordFailure(db, key); return { ok: true }; }
    const code = issueCode(db, 'staff', e);
    return config.demoMode && code ? { ok: true, demoCode: code } : { ok: true };
  });
}

function staffVerify(db, rawEmail, code) {
  const e = normEmail(rawEmail);
  return tx(db, () => {
    const r = verifyCode(db, 'staff', e, code);
    if (!r.ok) return r;
    audit(db, `staff:${e}`, 'login', {});
    return { ok: true, token: createSession(db, 'staff', e) };
  });
}

// Looks up the session for a cookie token and works out what it may do.
function sessionFor(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hmac(db, token));
  if (!s || s.expires_at <= nowIso()) return null;
  if (s.kind === 'parent') {
    const g = db.prepare('SELECT id, name, email FROM guardians WHERE id = ? AND active = 1').get(s.guardian_id);
    if (!g) return null;
    return { kind: 'parent', guardian: g, actor: `parent:${g.email}` };
  }
  const teacher = db.prepare('SELECT id, name, email, room FROM teachers WHERE email = ? AND active = 1').get(s.email);
  const admin = isAdminEmail(db, s.email);
  if (!teacher && !admin) return null;
  return { kind: 'staff', email: s.email, teacher: teacher || null, isAdmin: admin, actor: `${admin ? 'admin' : 'teacher'}:${s.email}` };
}

function endSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hmac(db, token));
}

function cleanup(db) {
  const t = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
  db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(new Date(Date.now() - 24 * 3600e3).toISOString());
}

module.exports = {
  parentStart, parentVerify, staffStart, staffVerify, sessionFor, endSession, cleanup, isAdminEmail,
  MAX_FAILURES, LOCK_MIN, NO_MATCH_MSG, _resetSecret: () => { secret = null; },
};
