'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

let app;
before(async () => { app = await startApp(); await app.setup(); });
after(() => app.close());

test('parent login: email + DOB + emailed 6-digit code', async () => {
  const c = app.client();
  app.clearLoginCodes('linh@example.com');
  const r = await c.post('/api/parent/login', { email: '  LINH@example.com ', dob: '2014-05-05' });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/api/parent/overview')).status, 401, 'not signed in until the code is entered');
  const code = app.latestCode('linh@example.com');
  assert.match(code, /^\d{6}$/);
  const v = await c.post('/api/parent/verify', { email: 'linh@example.com', code });
  assert.equal(v.status, 200);
  assert.match(v.text, /ok/);
  const me = (await c.get('/api/me')).body;
  assert.equal(me.role, 'parent');
  assert.equal(me.name, 'Linh Nguyễn');
  // A code works once.
  const c2 = app.client();
  assert.equal((await c2.post('/api/parent/verify', { email: 'linh@example.com', code })).status, 401);
  // Logging out ends the session.
  await c.post('/api/logout');
  assert.equal((await c.get('/api/parent/overview')).status, 401);
});

test('a wrong email/DOB pair gets the same generic message whether or not the email exists', async () => {
  const c = app.client();
  const a = await c.post('/api/parent/login', { email: 'linh@example.com', dob: '2014-05-06' });
  const b = await c.post('/api/parent/login', { email: 'nobody@example.com', dob: '2014-05-05' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
  assert.match(a.body.error, /We couldn't find a match/);
  assert.match(a.body.error, /front office/);
  // Nothing was emailed for failed matches.
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE to_email = 'nobody@example.com'").get().n, 0);
});

test('5 failed attempts lock that email for 15 minutes', async () => {
  const c = app.client();
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/parent/login', { email: 'maria@example.com', dob: '2000-01-01' })).status, 401);
  const fifth = await c.post('/api/parent/login', { email: 'maria@example.com', dob: '2000-01-01' });
  assert.equal(fifth.status, 429);
  // Even the right DOB is refused while locked.
  const right = await c.post('/api/parent/login', { email: 'maria@example.com', dob: '2014-09-09' });
  assert.equal(right.status, 429);
  assert.match(right.body.error, /15 minutes/);
  // After the lock expires, the right DOB works again.
  app.db.prepare("UPDATE login_failures SET locked_until = '2000-01-01T00:00:00.000Z' WHERE email = 'parent:maria@example.com'").run();
  assert.equal((await c.post('/api/parent/login', { email: 'maria@example.com', dob: '2014-09-09' })).status, 200);
});

test('wrong codes count as failures and burn the code after 5 tries', async () => {
  const c = app.client();
  app.clearLoginCodes('chidi@example.com');
  await c.post('/api/parent/login', { email: 'chidi@example.com', dob: '2015-01-10' });
  const real = app.latestCode('chidi@example.com');
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/parent/verify', { email: 'chidi@example.com', code: wrong })).status, 401);
  assert.equal((await c.post('/api/parent/verify', { email: 'chidi@example.com', code: wrong })).status, 429);
  app.db.prepare('DELETE FROM login_failures').run();
  assert.equal((await c.post('/api/parent/verify', { email: 'chidi@example.com', code: real })).status, 401, 'burned code no longer works');
});

test('an expired code is refused', async () => {
  const c = app.client();
  app.clearLoginCodes('aruiz@example.com');
  await c.post('/api/parent/login', { email: 'aruiz@example.com', dob: '2016-07-01' });
  const code = app.latestCode('aruiz@example.com');
  app.db.prepare("UPDATE login_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = 'aruiz@example.com'").run();
  const r = await c.post('/api/parent/verify', { email: 'aruiz@example.com', code });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /expired/);
});

test('staff login does not reveal who is on staff', async () => {
  const c = app.client();
  const a = await c.post('/api/staff/login', { email: 'rpatel@school.org' });
  const b = await c.post('/api/staff/login', { email: 'stranger@school.org' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE to_email = 'stranger@school.org'").get().n, 0);
});

test('roles only reach their own pages', async () => {
  const parent = await app.parent('linh@example.com', '2014-05-05');
  const teacher = await app.staff('rpatel@school.org');
  const admin = await app.staff('office@school.org');
  const anon = app.client();
  assert.equal((await anon.get('/api/teacher/schedule')).status, 401);
  assert.equal((await anon.get('/api/admin/dashboard')).status, 401);
  assert.equal((await parent.get('/api/teacher/schedule')).status, 403);
  assert.equal((await parent.get('/api/admin/dashboard')).status, 403);
  assert.equal((await teacher.get('/api/admin/dashboard')).status, 403);
  assert.equal((await teacher.get('/api/admin/export/family.csv')).status, 403);
  assert.equal((await teacher.get('/api/parent/overview')).status, 403);
  assert.equal((await admin.get('/api/admin/dashboard')).status, 200);
  // Admins who are not teachers have no teacher page.
  assert.equal((await admin.get('/api/teacher/schedule')).status, 403);
  // Uploads are refused before the body is even read.
  assert.equal((await teacher.post('/api/admin/upload/import', { files: {} })).status, 403);
});

test('cross-site form posts are refused', async () => {
  const parent = await app.parent('linh@example.com', '2014-05-05');
  const noHeader = await parent.post('/api/parent/attempts', {}, { headers: { 'x-requested-with': undefined } });
  assert.equal(noHeader.status, 403);
  const formType = await parent.req('POST', '/api/parent/attempts', {}, { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(formType.status, 415);
});

test('pages are marked no-index and locked down', async () => {
  const res = await app.client().get('/', { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const cookieRes = await (async () => {
    const c = app.client();
    app.clearLoginCodes('linh@example.com');
    await c.post('/api/parent/login', { email: 'linh@example.com', dob: '2014-05-05' });
    return fetch(`${app.base}/api/parent/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ptc' }, body: JSON.stringify({ email: 'linh@example.com', code: app.latestCode('linh@example.com') }) });
  })();
  const sc = cookieRes.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.equal((await app.client().get('/../src/db.js')).status, 404);
  assert.equal((await app.client().get('/data/ptc.sqlite')).status, 404);
});

test('session tokens are stored hashed, codes are stored hashed', async () => {
  const rows = app.db.prepare('SELECT token_hash FROM sessions').all();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.match(r.token_hash, /^[0-9a-f]{64}$/);
  for (const r of app.db.prepare('SELECT code_hash FROM login_codes').all()) assert.match(r.code_hash, /^[0-9a-f]{64}$/);
});
