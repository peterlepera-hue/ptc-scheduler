'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startApp } = require('./helpers');

const N = 50;
let app;
let parents;
let patel;
let times;

before(async () => {
  app = await startApp();
  await app.setup({ crowdSize: N });
  patel = app.teacherId('rpatel@school.org');
  times = app.slotTimes();
  parents = [];
  for (let i = 0; i < N; i++) parents.push(await app.parent(`crowd${i}@example.com`, '2014-06-15'));
});
after(() => app.close());

test(`${N} parents confirm the same slot at the same moment: exactly one succeeds`, async () => {
  const results = await Promise.all(parents.map((c, i) => c.post('/api/parent/bookings', {
    items: [{ teacher_id: patel, starts_at: times[0], student_id: app.studentId(String(5000 + i)) }],
  })));
  const ok = results.filter((r) => r.body.results[0].ok);
  const taken = results.filter((r) => r.body.results[0].code === 'SLOT_TAKEN');
  assert.equal(ok.length, 1);
  assert.equal(taken.length, N - 1);
  // Losers are offered the next open times.
  assert.ok(taken.every((r) => r.body.results[0].alternatives.length === 3 && r.body.results[0].alternatives[0].starts_at === times[1]));
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM booking_slots bs JOIN slots s ON s.id = bs.slot_id WHERE s.teacher_id = ? AND s.starts_at = ?').get(patel, times[0]).n, 1);
});

test('a stampede on every slot fills each slot exactly once', async () => {
  app.db.exec("DELETE FROM booking_slots; DELETE FROM booking_students; UPDATE bookings SET status = 'cancelled'");
  // Each of the 50 parents tries 3 random slots at once; 12 slots exist.
  const tries = [];
  parents.forEach((c, i) => {
    for (let k = 0; k < 3; k++) {
      const t = times[(i * 7 + k * 5) % times.length];
      tries.push(c.post('/api/parent/bookings', { items: [{ teacher_id: patel, starts_at: t, student_id: app.studentId(String(5000 + i)) }] }));
    }
  });
  const res = await Promise.all(tries);
  const oks = res.filter((r) => r.body.results[0].ok).length;
  const perSlot = app.db.prepare(`SELECT s.starts_at, COUNT(bs.slot_id) n FROM slots s LEFT JOIN booking_slots bs ON bs.slot_id = s.id
    WHERE s.teacher_id = ? GROUP BY s.id`).all(patel);
  assert.ok(perSlot.every((s) => s.n <= 1));
  const active = app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'active' AND teacher_id = ?").get(patel).n;
  assert.equal(active, oks);
  // A parent never ends up with two meetings with the same teacher.
  const dup = app.db.prepare("SELECT guardian_id, COUNT(*) n FROM bookings WHERE status = 'active' GROUP BY guardian_id, teacher_id HAVING n > 1").all();
  assert.deepEqual(dup, []);
});

test('separate processes writing to the same database still cannot double book', async () => {
  app.db.exec("DELETE FROM booking_slots; DELETE FROM booking_students; UPDATE bookings SET status = 'cancelled'");
  const dbFile = path.join(app.dir, 'test.sqlite');
  const workers = 8;
  const eventId = app.db.prepare('SELECT id FROM events WHERE is_current = 1').get().id;
  const outs = await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'fixtures', 'book-worker.js'), [], {
      env: { ...process.env, DB_FILE: dbFile }, execArgv: ['--disable-warning=ExperimentalWarning'],
    });
    child.on('message', resolve);
    child.on('error', reject);
    child.send({
      eventId, teacherId: patel, startsAt: times[0],
      // Each worker books for 6 different families, all wanting the same slot.
      people: Array.from({ length: 6 }, (_, k) => {
        const i = w * 6 + k;
        return { guardianId: app.guardianId(`crowd${i}@example.com`), studentId: app.studentId(String(5000 + i)) };
      }),
    });
  })));
  const all = outs.flat();
  assert.equal(all.length, workers * 6);
  assert.equal(all.filter((r) => r.ok).length, 1, JSON.stringify(all.filter((r) => !r.ok && r.code !== 'SLOT_TAKEN')));
  assert.equal(all.filter((r) => r.code === 'SLOT_TAKEN').length, workers * 6 - 1);
});
