'use strict';
// School time zone helpers.
// Every instant is stored as a UTC ISO string (e.g. 2026-10-15T19:00:00.000Z).
// Every time a person types or reads is wall-clock time in the school's zone.

const config = require('./config');

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidYMD(s) {
  const m = YMD.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isValidHM(s) {
  return HM.test(String(s || ''));
}

function hmToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHM(n) {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

const partFormatters = new Map();
function partsInZone(date, zone = config.timeZone) {
  let f = partFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partFormatters.set(zone, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetMs(ms, zone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = partsInZone(new Date(whole), zone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

// Wall-clock date + time in the school zone -> Date (UTC instant).
// Throws for times that do not exist (the skipped hour when clocks spring forward).
function zonedToUtc(dateStr, timeStr, zone = config.timeZone) {
  if (!isValidYMD(dateStr)) throw new Error(`Invalid date "${dateStr}" (use YYYY-MM-DD).`);
  if (!isValidHM(timeStr)) throw new Error(`Invalid time "${timeStr}" (use 24-hour HH:MM).`);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(guess, zone);
  t = guess - offsetMs(t, zone);
  const p = partsInZone(new Date(t), zone);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== h || p.mi !== mi) {
    throw new Error(`${dateStr} ${timeStr} does not exist in ${zone} (daylight saving change).`);
  }
  return new Date(t);
}

function localDate(iso, zone = config.timeZone) {
  const p = partsInZone(new Date(iso), zone);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function localHM(iso, zone = config.timeZone) {
  const p = partsInZone(new Date(iso), zone);
  return minutesToHM(p.h * 60 + p.mi);
}

function fmtTime(iso, zone = config.timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function fmtDate(iso, zone = config.timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

function fmtDateTime(iso, zone = config.timeZone) {
  return `${fmtDate(iso, zone)}, ${fmtTime(iso, zone)}`;
}

function fmtRange(startIso, endIso, zone = config.timeZone) {
  return `${fmtTime(startIso, zone)}–${fmtTime(endIso, zone)}`;
}

// "2026-10-15T15:00" style local input -> ISO instant.
function localInputToIso(s, zone = config.timeZone) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(s || '').trim());
  if (!m) throw new Error(`Invalid date and time "${s}" (use YYYY-MM-DD HH:MM).`);
  return zonedToUtc(m[1], m[2], zone).toISOString();
}

function isoToLocalInput(iso, zone = config.timeZone) {
  return `${localDate(iso, zone)}T${localHM(iso, zone)}`;
}

module.exports = {
  isValidYMD, isValidHM, hmToMinutes, minutesToHM, zonedToUtc, localDate, localHM,
  fmtTime, fmtDate, fmtDateTime, fmtRange, localInputToIso, isoToLocalInput, partsInZone,
};
