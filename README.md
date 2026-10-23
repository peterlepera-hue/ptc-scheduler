# Parent-Teacher Conference Scheduler

Built from `PTCSPEC.md`. Parents book up to 4 conferences per child from a phone, teachers see their day and a "tried to book" list, and the office runs everything from four SIS uploads.

## Try it (2 minutes)

Needs Node.js 22.13 or newer.

```
npm install
npm run demo
```

Open http://localhost:3000. The demo builds a fake school; sign-in codes print in the terminal instead of being emailed.

| Role | Sign in with |
| --- | --- |
| Parent | `parent@demo.school` + date of birth `2014-03-22` (Maya) |
| Teacher | Staff sign in, `green@demo.school` |
| Admin | Staff sign in, `office@demo.school` |

## Run the tests

```
npm test          # 52 tests: booking rules, races, sign-in, uploads, emails
npm run test:e2e  # 7 browser tests (parent on a phone, teacher, admin)
```

The browser tests need Chromium. If Playwright's own browser isn't installed, set `CHROMIUM_PATH` to a Chrome/Chromium binary.

## What's covered from the spec

- **Parents:** email + child's date of birth, then a 6-digit emailed code. Siblings appear together; twins work. Pick times, back-to-back warning (dismissable), review, confirm. Change or cancel until the cutoff (default 6 hours). "Let the teacher know I'd like to meet" when a teacher is full. Counter per child ("Maya: 2 of 4").
- **Teachers:** emailed one-time code sign-in. Schedule with separate student and parent columns, notes, co-teachers. Block times before booking opens. Add a parent manually (counts toward the 4, same email). Move/cancel their own conferences. Tried-to-book list with Contacted / Scheduled another time. Print and CSV.
- **Admin:** upload the 4 files (.csv or .xlsx) with a full validation report; nothing imports until clean. Re-uploads update records and never delete bookings. Event setup (multi-day, slot length, booking window, cutoff, limit, reminder times). Dashboard (booked vs open per teacher, families with nothing booked, tried-to-book counts, email failures). Book/move/cancel for any family, raise one child's limit, teacher unavailable (bulk cancel + email), resend any email, master schedule by teacher/room/family (print or CSV), activity log, delete family data after the event.
- **Emails:** booking open, nudge 2 days before close to families with nothing booked, confirmation on book/change/cancel with a calendar (.ics) file, reminders at admin-set times, slot-cancelled, teacher summaries at booking close and on conference morning. Queued in the database and retried; failures and bounces show on the dashboard.

## How double booking is prevented

The database enforces the rules, not just the screen:

- A slot can belong to only one booking (`booking_slots.slot_id` is the primary key).
- A trigger refuses a booking past the child's limit; another refuses a parent in two places at once.
- One meeting per parent per teacher is a unique index.
- Every booking runs in a write-locked transaction.

Tests prove it: 50 parents confirming the same slot at once get exactly one success; separate processes writing to the same database still can't double book; and with the app's own checks deleted, the database still holds.

## Running it for real

Set these environment variables, then `npm start`:

| Variable | Example | Notes |
| --- | --- | --- |
| `BASE_URL` | `https://conferences.yourschool.org` | Used in email links. HTTPS turns on secure cookies. |
| `ADMIN_EMAILS` | `office@yourschool.org,principal@yourschool.org` | Who can sign in as admin. More can be added in Settings. |
| `SCHOOL_NAME` | `Lincoln Middle School` | |
| `HELP_CONTACT` | `the front office at (555) 010-0100` | Shown on every screen and email. |
| `MAIL_TRANSPORT` | `smtp` | Default `outbox` stores emails without sending (test mode). |
| `SMTP_URL` | `smtps://apikey:KEY@smtp.sendgrid.net:465` | Works with SendGrid, Postmark, Amazon SES, Resend (all offer SMTP). |
| `MAIL_FROM` | `Lincoln Conferences <conferences@yourschool.org>` | Use a school domain with SPF/DKIM set up so mail isn't spam. |
| `SCHOOL_TIMEZONE` | `America/New_York` | Default. |
| `DATA_DIR` | `/var/lib/ptc` | Where the SQLite database lives. Back it up. |
| `TRUST_PROXY` | `1` | Set when behind a load balancer, so rate limits see real IPs. |
| `EMAIL_WEBHOOK_SECRET` | random string | Lets your email provider report bounces to `POST /api/webhooks/email-events` (header `x-webhook-secret`). |

Run one server process behind HTTPS (any host that encrypts disks at rest). SQLite handles a school's booking stampede comfortably; the tests simulate it.

## Not built yet (needs a decision or school accounts)

- **Google/Microsoft single sign-on for teachers.** Teachers use an emailed one-time code today (the spec's fallback). SSO needs the school's Google Workspace or Microsoft 365 app registration.
- **Translated screens and emails, virtual/phone meetings, feedback survey** (spec's "Suggested additions").
- **Automatic data deletion.** The admin deletes family data from Settings; it doesn't run on a timer.
- **PDF export** is the browser's print-to-PDF of the printable pages.

## Decisions the spec left open (defaults chosen)

- Support (SPED/ELL) teachers are booked only through co-taught sections, unless they also teach the student another section directly.
- Upload 4 is optional; if it's missing you get a warning.
- Teachers can block times only before booking opens (per the spec); the office can block any time.
- Parents can change/cancel until the cutoff; new bookings follow the booking window.
- Excel drops leading zeros from numeric SIS IDs. Export all four reports the same way (all .csv or all .xlsx) so IDs match.

## Layout

```
src/        server, database, booking engine, importer, emails, timed jobs
public/     the web app (one page, no build step)
test/       automated tests      e2e/  browser tests      scripts/demo.js
```
