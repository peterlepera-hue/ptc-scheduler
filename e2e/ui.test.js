'use strict';
// Drives the real web app in Chromium: a parent on a phone, a teacher and the
// office admin. Fails on any browser console error or uncaught page error.
//   npm run test:e2e        (set CHROMIUM_PATH if Playwright's own browser isn't installed)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { startApp, fixtureFiles, eventInput } = require('../test/helpers');

const SHOTS = process.env.SCREENSHOT_DIR || '';
let app;
let browser;
const pageErrors = [];

function exe() {
  for (const p of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].filter(Boolean)) if (fs.existsSync(p)) return p;
  return undefined;
}

async function newPage(opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  // 401/409 responses are expected API answers (wrong sign-in, slot taken) that the page shows to the user.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|409)/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
  return page;
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function signInParent(page, email, dob) {
  await page.goto(app.base);
  await page.getByLabel('Your email address').fill(email);
  await page.getByLabel('Your child\'s date of birth').fill(dob);
  app.clearLoginCodes(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Sign-in code').waitFor();
  await page.getByLabel('Sign-in code').fill(app.latestCode(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signInStaff(page, email) {
  await page.goto(`${app.base}/#/staff`);
  await page.getByLabel('School email').fill(email);
  app.clearLoginCodes(email);
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByLabel('Sign-in code').waitFor();
  await page.getByLabel('Sign-in code').fill(app.latestCode(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
}

before(async () => {
  app = await startApp();
  browser = await chromium.launch({ executablePath: exe() });
});
after(async () => {
  await browser.close();
  await app.close();
});

test('admin: upload the four files, see the validation report, import, set up the event', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 } });
  await signInStaff(page, 'office@school.org');
  await page.getByRole('heading', { name: 'Welcome' }).waitFor();
  await shot(page, '01-admin-welcome');
  await page.getByRole('link', { name: 'Upload data' }).first().click();
  const files = fixtureFiles();
  const tmp = fs.mkdtempSync(path.join(app.dir, 'up-'));
  const write = (k) => { const p = path.join(tmp, files[k].name); fs.writeFileSync(p, Buffer.from(files[k].data, 'base64')); return p; };
  // First a broken teachers file: one room missing.
  const badTeachers = path.join(tmp, 'bad-teachers.csv');
  fs.writeFileSync(badTeachers, fs.readFileSync(write('teachers'), 'utf8').replace('Ms. Green,green@school.org,ENG6-02,110', 'Ms. Green,green@school.org,ENG6-02,'));
  await page.getByLabel('Upload 1: Students and parents').setInputFiles(write('students'));
  await page.getByLabel('Upload 2: Student schedules').setInputFiles(write('schedules'));
  await page.getByLabel('Upload 3: Teacher sections').setInputFiles(badTeachers);
  await page.getByLabel(/Upload 4/).setInputFiles(write('supports'));
  await page.getByRole('button', { name: 'Check files' }).click();
  await page.getByText('Room Number is missing for Ms. Green').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Import' }).isDisabled(), true);
  await shot(page, '02-admin-upload-errors');
  await page.getByLabel('Upload 3: Teacher sections').setInputFiles(write('teachers'));
  await page.getByRole('button', { name: 'Check files' }).click();
  await page.getByText('No errors.').waitFor();
  await page.getByRole('button', { name: 'Import' }).click();
  await page.getByText('Imported.', { exact: false }).first().waitFor();
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM students').get().n, 7);

  await page.getByRole('link', { name: 'Event setup' }).click();
  const ev = eventInput();
  await page.getByLabel('Event name').fill('Fall Conferences');
  await page.getByLabel('Day 1').fill(ev.days[0].day);
  await page.getByLabel('Start', { exact: true }).fill('15:00');
  await page.getByLabel('End', { exact: true }).fill('17:00');
  await page.getByLabel('Booking opens').fill(ev.booking_opens_at);
  await page.getByLabel('Booking closes').fill(ev.booking_closes_at);
  await page.getByLabel(/Building, entry door/).fill('Enter through the main doors on Elm St.');
  await shot(page, '03-admin-event');
  await page.getByRole('button', { name: 'Create event' }).click();
  await page.getByText(/Saved\./).waitFor();
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM slots').get().n, 9 * 12);
  const remind = JSON.parse(app.db.prepare('SELECT reminder_times FROM events').get().reminder_times);
  assert.equal(remind.length, 2, 'default reminders filled in');

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'Send booking-open email' }).click();
  await page.getByRole('button', { name: 'Send emails' }).click();
  await page.getByText(/Booking-open email sent/).waitFor();
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM emails WHERE kind = 'booking_open'").get().n, 5);
  await page.context().close();
});

test('parent on a phone: sign in, pick times, see the back-to-back warning, confirm, change, cancel', async () => {
  const page = await newPage({ ...devices['iPhone 13'], browserName: undefined, defaultBrowserType: undefined });
  // Wrong DOB first: generic message.
  await page.goto(app.base);
  await page.getByLabel('Your email address').fill('aruiz@example.com');
  await page.getByLabel('Your child\'s date of birth').fill('2014-03-23');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('We couldn\'t find a match').waitFor();
  await shot(page, '10-parent-no-match');
  await signInParent(page, 'aruiz@example.com', '2014-03-22');
  await page.getByRole('heading', { name: 'Maya Thompson' }).waitFor();
  await page.getByRole('heading', { name: 'Leo Ruiz' }).waitFor();
  await page.getByText('Maya: 0 of 4 conferences booked').waitFor();
  await shot(page, '11-parent-teachers');

  const maya = page.locator('section', { has: page.getByRole('heading', { name: 'Maya Thompson' }) });
  const teacherRow = (name) => maya.locator('.teacher', { has: page.getByText(name, { exact: true }) });
  await teacherRow('Mr. Patel').getByRole('button', { name: 'Choose a time' }).click();
  await page.locator('#picker .slot.open').first().waitFor();
  await shot(page, '12-parent-pick-time');
  await page.locator('#picker .slot.open').nth(0).click(); // 3:00
  await page.getByText(/added\. Review and confirm/).waitFor();
  // Ms. Green at 3:10 is back-to-back: warning appears.
  await teacherRow('Ms. Green').getByRole('button', { name: 'Choose a time' }).click();
  await page.locator('#picker .slot').nth(1).getByText('Back-to-back').waitFor();
  // The 3:00 time shows as busy (picked with Mr. Patel).
  assert.equal(await page.locator('#picker .slot').nth(0).isDisabled(), true);
  await page.locator('#picker .slot').nth(1).click();
  await page.getByText(/Warning! Each conference is 10 minutes and traveling to another room will take up meeting time\. We recommend switching to another time\./).waitFor();
  await shot(page, '13-parent-back-to-back-warning');
  await page.getByRole('button', { name: 'Keep this time' }).click();
  await page.getByText('Maya: 0 of 4 conferences booked (+2 picked)').waitFor();
  await page.getByRole('link', { name: 'Review and confirm' }).click();
  await page.getByRole('heading', { name: 'Review your conferences' }).waitFor();
  await page.getByLabel('Note for the teacher (optional)').first().fill('I\'d like to discuss reading');
  await shot(page, '14-parent-review');
  await page.getByRole('button', { name: 'Confirm 2 conferences' }).click();
  await page.getByRole('heading', { name: 'You\'re booked!' }).waitFor();
  await shot(page, '15-parent-booked');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'active'").get().n, 2);
  assert.equal(app.db.prepare("SELECT note FROM bookings WHERE teacher_id = ?").get(app.teacherId('rpatel@school.org')).note, 'I\'d like to discuss reading');
  const conf = app.db.prepare("SELECT * FROM emails WHERE kind = 'confirmation_booked' AND to_email = 'aruiz@example.com'").get();
  assert.ok(conf && conf.ics.includes('BEGIN:VEVENT'));
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('Maya: 2 of 4 conferences booked').waitFor();

  // Change Mr. Patel to a later time.
  const patelBooking = page.locator('.booking', { has: page.getByText('Mr. Patel') });
  await patelBooking.getByRole('button', { name: 'Change time' }).click();
  await page.locator('#picker .slot.current').waitFor();
  await page.locator('#picker .slot.open').last().click();
  await page.getByRole('button', { name: 'Change time' }).last().click();
  await page.getByText(/Conference time changed/).waitFor();
  const t = app.db.prepare("SELECT starts_at FROM bookings WHERE status = 'active' AND teacher_id = ?").get(app.teacherId('rpatel@school.org')).starts_at;
  assert.equal(t, app.slotTimes()[11]);

  // Cancel Ms. Green.
  await page.locator('.booking', { has: page.getByText('Ms. Green') }).getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Cancel conference' }).click();
  await page.getByText('Conference cancelled').waitFor();
  await page.getByText('Maya: 1 of 4 conferences booked').waitFor();
  await shot(page, '16-parent-after-changes');
  await page.context().close();
});

test('parent: a fully booked teacher offers "Let the teacher know I\'d like to meet"', async () => {
  const fox = app.teacherId('fox@school.org');
  app.db.prepare("UPDATE slots SET status = 'blocked' WHERE teacher_id = ?").run(fox);
  const page = await newPage({ ...devices['Pixel 7'], defaultBrowserType: undefined });
  await signInParent(page, 'chidi@example.com', '2017-02-02');
  const jamie = page.locator('section', { has: page.getByRole('heading', { name: 'Jamie Okafor' }) });
  await jamie.getByText('This teacher is fully booked').waitFor();
  await jamie.getByRole('button', { name: 'Let the teacher know I\'d like to meet' }).click();
  await page.getByLabel('Note for the teacher (optional)').fill('Any time after 4pm works');
  await shot(page, '17-parent-tried-to-book');
  await page.getByRole('button', { name: 'Send' }).click();
  await jamie.getByText('We let Ms. Fox know you\'d like to meet.').waitFor();
  app.db.prepare("UPDATE slots SET status = 'open' WHERE teacher_id = ?").run(fox);
  await page.context().close();
});

test('teacher: sees the schedule with separate student and parent columns, the tried-to-book list, and adds a parent', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 } });
  await signInStaff(page, 'rpatel@school.org');
  await page.getByRole('heading', { name: 'Your conference schedule' }).waitFor();
  const row = page.locator('tr', { has: page.getByText('Maya Thompson') });
  await row.getByText('Andrea Ruiz').waitFor();
  await row.getByText('I\'d like to discuss reading').waitFor();
  await shot(page, '20-teacher-schedule');
  // Booking is open, so blocking is explained, not offered.
  await page.getByText(/times can no longer be blocked here/).waitFor();
  // Add José's parent into the first open slot.
  await page.locator('tr.is-open').first().getByRole('button', { name: 'Add parent' }).click();
  await page.getByLabel('Student').fill('José');
  await page.getByText('José García-López').click();
  await shot(page, '21-teacher-add-parent');
  await page.getByRole('button', { name: 'Book' }).click();
  await page.getByText('Booked. The family was emailed.').waitFor();
  await page.locator('tr', { has: page.getByText('José García-López') }).getByText('María García-López').waitFor();
  const m = app.db.prepare("SELECT kind FROM emails WHERE to_email = 'maria@example.com' ORDER BY id DESC LIMIT 1").get();
  assert.equal(m.kind, 'confirmation_booked');
  await page.context().close();

  const fox = await newPage({ viewport: { width: 1280, height: 900 } });
  await signInStaff(fox, 'fox@school.org');
  await fox.getByText('Any time after 4pm works').waitFor();
  await fox.getByLabel('Status for Jamie Okafor').selectOption('contacted');
  await fox.getByText('Saved').waitFor();
  assert.equal(app.db.prepare('SELECT status FROM attempts').get().status, 'contacted');
  await shot(fox, '22-teacher-tried-to-book');
  await fox.context().close();
});

test('teacher schedule works on a phone, and print hides the buttons', async () => {
  const page = await newPage({ ...devices['iPhone 13'], defaultBrowserType: undefined });
  await signInStaff(page, 'green@school.org');
  await page.getByRole('heading', { name: 'Your conference schedule' }).waitFor();
  await shot(page, '23-teacher-phone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no sideways scrolling on a phone');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.getByRole('button', { name: 'Print' }).isVisible(), false);
  await page.context().close();
});

test('admin: book for a family without email, raise a limit, mark a teacher unavailable, print the master schedule', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 } });
  await signInStaff(page, 'office@school.org');
  await page.getByRole('link', { name: 'Families' }).click();
  await page.getByLabel('Search').fill('Linh');
  await page.getByRole('link', { name: 'Linh Nguyễn' }).click();
  await page.getByRole('heading', { name: 'Linh Nguyễn' }).waitFor();
  const ana = page.locator('section', { has: page.getByRole('heading', { name: 'Ana Nguyễn' }) });
  await ana.getByText('Meets together with Ms. Lee (Room 120)').waitFor();
  await ana.locator('.teacher', { has: page.getByText('Ms. Green', { exact: true }) }).getByRole('button', { name: 'Choose a time' }).click();
  await page.locator('#picker .slot.open').first().click();
  await page.getByRole('button', { name: 'Book', exact: true }).click();
  await page.getByText('Booked and emailed').waitFor();
  await shot(page, '30-admin-family');
  const b = app.db.prepare("SELECT id FROM bookings WHERE status = 'active' AND guardian_id = ?").get(app.guardianId('linh@example.com'));
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM booking_slots WHERE booking_id = ?').get(b.id).n, 2, 'co-teacher reserved too');
  await ana.getByRole('button', { name: 'Change Ana\'s limit' }).click();
  await page.getByLabel('Maximum conferences').fill('6');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Ana: 1 of 6 conferences booked').waitFor();

  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('heading', { name: 'Teachers' }).waitFor();
  await shot(page, '31-admin-dashboard');
  await page.getByRole('link', { name: 'Mr. Patel' }).click();
  await page.getByRole('button', { name: 'Teacher unavailable…' }).click();
  await page.getByRole('button', { name: 'Cancel all and email families' }).click();
  await page.getByText(/conferences? cancelled/).waitFor();
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'active' AND teacher_id = ?").get(app.teacherId('rpatel@school.org')).n, 0);

  await page.getByRole('link', { name: 'Print & export' }).click();
  await page.getByRole('link', { name: 'Printable page' }).nth(1).click();
  await page.getByRole('heading', { name: /by room/ }).waitFor();
  await page.getByRole('heading', { name: 'Room 110' }).waitFor();
  await shot(page, '32-admin-print-by-room');
  await page.getByRole('link', { name: 'Activity log' }).click();
  await page.getByText('teacher.unavailable').waitFor();
  await page.getByRole('link', { name: 'Emails' }).click();
  await page.getByText('Test mode:').waitFor();
  await page.context().close();
});

test('no browser errors anywhere', () => {
  assert.deepEqual(pageErrors, []);
});
