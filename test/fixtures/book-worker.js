'use strict';
// Child process for the multi-process test: opens the shared database file
// directly and tries to book the same slot for several families.
const { open } = require('../../src/db');
const booking = require('../../src/booking');

process.on('message', (job) => {
  const db = open(process.env.DB_FILE);
  const out = [];
  for (const p of job.people) {
    const r = booking.book(db, {
      eventId: job.eventId, guardianId: p.guardianId, teacherId: job.teacherId, startsAt: job.startsAt,
      studentId: p.studentId, note: '', actor: 'worker', role: 'parent',
    });
    out.push({ ok: r.ok, code: r.code });
  }
  db.close();
  process.send(out, () => process.exit(0));
});
