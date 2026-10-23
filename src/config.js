'use strict';
// All settings come from environment variables so the same code runs in
// development, tests and production. See README.md for the full list.

const path = require('node:path');

function list(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // RENDER_EXTERNAL_URL is set automatically on Render.com.
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  timeZone: process.env.SCHOOL_TIMEZONE || 'America/New_York',
  schoolName: process.env.SCHOOL_NAME || 'Our School',
  helpContact: process.env.HELP_CONTACT || 'the school office',
  adminEmails: list(process.env.ADMIN_EMAILS),
  sessionSecret: process.env.SESSION_SECRET || '',
  mailTransport: process.env.MAIL_TRANSPORT || 'outbox', // outbox | smtp
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'Conferences <conferences@localhost>',
  emailWebhookSecret: process.env.EMAIL_WEBHOOK_SECRET || '',
  // Development only: print one-time codes to the server log. Never enable in production.
  devShowCodes: process.env.DEV_SHOW_CODES === '1',
  // Demo sites only (fake data): sign-in codes are shown on screen so testers
  // don't need a working mailbox. Never enable with real family data.
  demoMode: process.env.DEMO_MODE === '1',
  secureCookies: process.env.SECURE_COOKIES ? process.env.SECURE_COOKIES === '1' : /^https:/.test(process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || ''),
  trustProxy: process.env.TRUST_PROXY === '1',
  // Timers can be switched off for tests.
  disableTimers: process.env.DISABLE_TIMERS === '1',
};

module.exports = config;
