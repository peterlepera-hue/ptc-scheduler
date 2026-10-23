'use strict';
// Who teaches whom, and who attends each family meeting.
//
// A student's teachers come from matching their sections (Upload 2) with the
// teacher sections (Upload 3). For a student listed in Upload 4, the support
// teacher joins every meeting with the other teacher(s) of that co-taught
// section. A support teacher linked to the student only through co-taught
// sections is not listed separately: they attend those meetings instead.

function teacherLinksForStudent(db, studentId) {
  const rows = db.prepare(`SELECT sec.teacher_id, e.section_code FROM enrollments e
    JOIN sections sec ON sec.code = e.section_code
    JOIN teachers t ON t.id = sec.teacher_id AND t.active = 1
    WHERE e.student_id = ?`).all(studentId);
  const sup = db.prepare(`SELECT s.teacher_id, s.section_code FROM supports s
    JOIN teachers t ON t.id = s.teacher_id AND t.active = 1 WHERE s.student_id = ?`).all(studentId);
  const supportBySection = new Map();
  for (const s of sup) {
    if (!supportBySection.has(s.section_code)) supportBySection.set(s.section_code, new Set());
    supportBySection.get(s.section_code).add(s.teacher_id);
  }
  const links = new Map(); // teacherId -> { sections: Set, coTeachers: Set }
  const add = (tid) => {
    if (!links.has(tid)) links.set(tid, { sections: new Set(), coTeachers: new Set() });
    return links.get(tid);
  };
  for (const r of rows) {
    const supporters = supportBySection.get(r.section_code);
    if (supporters && supporters.has(r.teacher_id)) continue; // support teacher in their own co-taught section
    const l = add(r.teacher_id);
    l.sections.add(r.section_code);
    if (supporters) for (const s of supporters) if (s !== r.teacher_id) l.coTeachers.add(s);
  }
  // A teacher who is both a regular teacher and a co-teacher of the same meeting attends once.
  for (const [tid, l] of links) l.coTeachers.delete(tid);
  return links;
}

function childrenOfGuardian(db, guardianId) {
  return db.prepare(`SELECT s.id, s.sis_id, s.first_name, s.last_name, s.dob, sg.relation FROM student_guardians sg
    JOIN students s ON s.id = sg.student_id AND s.active = 1
    WHERE sg.guardian_id = ? ORDER BY s.first_name COLLATE NOCASE, s.last_name COLLATE NOCASE, s.id`).all(guardianId);
}

// The meeting a guardian would have with a teacher: which of their children it
// covers (siblings who share the teacher get one meeting) and who co-attends.
function meetingFor(db, guardianId, teacherId) {
  const covered = [];
  const co = new Set();
  for (const c of childrenOfGuardian(db, guardianId)) {
    const l = teacherLinksForStudent(db, c.id).get(teacherId);
    if (!l) continue;
    covered.push(c.id);
    for (const t of l.coTeachers) co.add(t);
  }
  co.delete(teacherId);
  return { covered, coTeachers: [...co].sort((a, b) => a - b) };
}

function teacherInfo(db, ids) {
  if (!ids.length) return [];
  const q = db.prepare('SELECT id, name, email, room FROM teachers WHERE id = ?');
  return ids.map((id) => q.get(id)).filter(Boolean);
}

// Students (and their guardians) that a teacher can meet about: the teacher's
// own students plus students they co-teach as a support teacher.
function rosterForTeacher(db, teacherId) {
  const candidates = db.prepare(`SELECT DISTINCT e.student_id FROM enrollments e JOIN sections sec ON sec.code = e.section_code
      WHERE sec.teacher_id = ?
    UNION SELECT DISTINCT student_id FROM supports WHERE teacher_id = ?`).all(teacherId, teacherId);
  const out = [];
  const sQ = db.prepare('SELECT id, sis_id, first_name, last_name FROM students WHERE id = ? AND active = 1');
  const gQ = db.prepare(`SELECT g.id, g.name, g.email, sg.relation FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id
    WHERE sg.student_id = ? AND g.active = 1 ORDER BY sg.relation, g.name`);
  for (const { student_id: sid } of candidates) {
    const s = sQ.get(sid);
    if (!s) continue;
    const links = teacherLinksForStudent(db, sid);
    let role = null;
    if (links.has(teacherId)) role = 'teacher';
    else {
      for (const [tid, l] of links) if (l.coTeachers.has(teacherId)) { role = 'co'; s.primary_teacher_id = tid; break; }
    }
    if (!role) continue;
    s.role = role;
    s.sections = role === 'teacher' ? [...links.get(teacherId).sections] : [];
    s.guardians = gQ.all(sid);
    out.push(s);
  }
  out.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  return out;
}

module.exports = { teacherLinksForStudent, childrenOfGuardian, meetingFor, teacherInfo, rosterForTeacher };
