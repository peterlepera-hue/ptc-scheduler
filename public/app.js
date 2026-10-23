'use strict';
// Parent-teacher conference scheduler: one page, three views (parent, teacher, admin).
// Everything is built with DOM methods (never innerHTML), so names can't inject markup.

(function () {
  const $app = document.getElementById('app');
  const state = {
    me: null,
    tz: 'America/New_York',
    cart: [],
    pending: null, // { kind: 'parent'|'staff', email, dob }
    picker: null, // { childId, teacherId, mode: 'book'|'move', bookingId }
    overview: null,
    results: null,
  };

  // ---------- DOM ----------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (['checked', 'disabled', 'selected', 'required', 'multiple', 'autofocus'].includes(k)) el[k] = Boolean(v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    add(el, children);
    return el;
  }
  function add(el, kids) {
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function view(nodes, { narrow = false } = {}) {
    $app.className = narrow ? 'narrow' : '';
    $app.replaceChildren();
    add($app, [nodes]);
  }
  function spinner() { view(h('div', { class: 'spinner', role: 'status' }, 'Loading…')); }
  function banner(kind, ...content) { return h('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...content); }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, message, data) { super(message); this.status = status; this.data = data || {}; }
  }
  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') {
      opts.headers['content-type'] = 'application/json';
      opts.headers['x-requested-with'] = 'ptc';
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try { res = await fetch(path, opts); } catch {
      throw new ApiError(0, 'We could not reach the server. Check your internet connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      if (res.status === 401 && !/\/(login|verify)$/.test(path)) state.me = null;
      throw new ApiError(res.status, (data && data.error) || `Something went wrong (error ${res.status}).`, data);
    }
    return data;
  }

  // ---------- formatting (always in the school's time zone) ----------
  const fmtCache = new Map();
  function fmt(opts) {
    const key = state.tz + JSON.stringify(opts);
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: state.tz, ...opts }));
    return fmtCache.get(key);
  }
  const fmtTime = (iso) => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const fmtDay = (iso) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso));
  const fmtDayShort = (iso) => fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
  const fmtDateTime = (iso) => `${fmtDay(iso)} at ${fmtTime(iso)}`;
  const fmtRange = (a, b) => `${fmtTime(a)}–${fmtTime(b)}`;
  const dayKey = (iso) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  function localDayFromYmd(ymd) {
    // A calendar date (no time) shown as a weekday, independent of time zones.
    const [y, m, d] = ymd.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  function hm12(hm) {
    const [hh, mm] = hm.split(':').map(Number);
    return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  }
  function ymdToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------- dialogs and toasts ----------
  let toastTimer = null;
  function toast(message) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, message);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 4000);
  }

  // Shows a modal dialog. Resolves with the clicked action's value (or null when dismissed).
  function modal({ title, body = [], actions = [], onSubmit = null }) {
    return new Promise((resolve) => {
      const err = h('div');
      const form = h('form', { method: 'dialog' });
      const dlg = h('dialog', { 'aria-labelledby': 'dlg-title' }, form);
      add(form, [
        h('div', { class: 'dialog-body' }, h('h2', { id: 'dlg-title' }, title), body, err),
        h('div', { class: 'dialog-actions' }, actions.map((a) => h('button', {
          type: a.submit ? 'submit' : 'button', class: a.class || '', value: a.value,
          onclick: a.submit ? null : () => { dlg.close(); resolve(a.value ?? null); },
        }, a.label))),
      ]);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitter = e.submitter;
        if (onSubmit) {
          err.replaceChildren();
          const btns = form.querySelectorAll('button');
          btns.forEach((b) => { b.disabled = true; });
          try {
            const out = await onSubmit(submitter ? submitter.value : null);
            if (out === false) { btns.forEach((b) => { b.disabled = false; }); return; }
            dlg.close();
            resolve(out === undefined ? true : out);
          } catch (ex) {
            btns.forEach((b) => { b.disabled = false; });
            err.replaceChildren(banner('error', ex.message));
          }
        } else {
          dlg.close();
          resolve(submitter ? submitter.value : true);
        }
      });
      dlg.addEventListener('cancel', () => resolve(null));
      dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
      document.body.append(dlg);
      dlg.showModal();
      const first = dlg.querySelector('input, textarea, select');
      if (first) first.focus();
    });
  }

  async function confirmBox(title, message, okLabel = 'OK', { danger = false, cancelLabel = 'Cancel' } = {}) {
    const v = await modal({
      title, body: [].concat(message).map((m) => (m instanceof Node ? m : h('p', {}, m))),
      actions: [{ label: cancelLabel, value: 'no' }, { label: okLabel, value: 'yes', submit: true, class: danger ? 'danger solid' : 'primary' }],
    });
    return v === 'yes';
  }

  async function act(fn, success) {
    try {
      const out = await fn();
      if (success) toast(success);
      return out;
    } catch (e) {
      await modal({ title: 'That didn\'t work', body: [h('p', {}, e.message)], actions: [{ label: 'OK', submit: true, class: 'primary' }] });
      return null;
    }
  }

  // ---------- shell ----------
  function setChrome() {
    const me = state.me || {};
    document.getElementById('brand').textContent = me.school ? `${me.school} Conferences` : 'Conferences';
    document.title = me.event ? `${me.event.name} · ${me.school || ''}` : 'Conference Sign-up';
    const actions = document.getElementById('topbar-actions');
    actions.replaceChildren();
    if (me.role) {
      const label = me.role === 'parent' ? me.name : (me.teacher ? me.teacher.name : me.email);
      add(actions, [
        h('span', { class: 'who hide-sm' }, label),
        me.role === 'staff' && me.isAdmin && me.teacher ? h('a', { class: 'btn small-btn', href: location.hash.startsWith('#/admin') ? '#/teacher' : '#/admin' }, location.hash.startsWith('#/admin') ? 'My schedule' : 'Admin') : null,
        h('button', { class: 'small-btn', type: 'button', onclick: signOut }, 'Sign out'),
      ]);
    }
    const help = document.getElementById('help');
    help.replaceChildren(`Need help? Contact ${me.help || 'the school office'}.`);
    document.querySelectorAll('.demo-strip').forEach((x) => x.remove());
    if (me.demo) document.body.prepend(h('div', { class: 'demo-strip', role: 'note' }, 'Demo site with made-up families. Sign-in codes are shown on screen and no emails are sent.'));
  }

  async function signOut() {
    try { await api('POST', '/api/logout'); } catch { /* already signed out */ }
    state.me = null; state.cart = []; state.overview = null; state.picker = null; state.results = null;
    go('#/');
  }

  async function loadMe() {
    state.me = await api('GET', '/api/me');
    state.tz = state.me.timeZone || state.tz;
  }

  // ---------- router ----------
  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (!state.me) { spinner(); await loadMe(); }
      setChrome();
      const role = state.me.role;
      const [p0, p1, p2] = parts;
      if (!p0) {
        if (role === 'parent') return go('#/parent');
        if (role === 'staff') return go(state.me.teacher ? '#/teacher' : '#/admin');
        return parentLogin();
      }
      if (p0 === 'staff') return role === 'staff' ? go('#/') : staffLogin();
      if (p0 === 'code') return codePage();
      if (p0 === 'parent') {
        if (role !== 'parent') return go('#/');
        if (p1 === 'review') return reviewPage();
        return parentPage();
      }
      if (p0 === 'teacher') {
        if (role !== 'staff' || !state.me.teacher) return go('#/');
        return teacherPage();
      }
      if (p0 === 'admin') {
        if (role !== 'staff' || !state.me.isAdmin) return go('#/');
        return adminPage(p1 || 'dashboard', p2);
      }
      return go('#/');
    } catch (e) {
      if (e.status === 401) { state.me = null; return go('#/'); }
      view(h('div', { class: 'card' }, banner('error', e.message), h('button', { type: 'button', onclick: () => route() }, 'Try again')));
    }
  }
  window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

  // ---------- sign in ----------
  function eventLine(ev) {
    if (!ev) return null;
    const days = ev.days.map((d) => localDayFromYmd(d.day)).join(' and ');
    return h('p', { class: 'muted' }, `${ev.name}: ${days}`);
  }

  function parentLogin() {
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, inputmode: 'email', value: state.pending && state.pending.kind === 'parent' ? state.pending.email : '' });
    const dob = h('input', { type: 'date', id: 'dob', required: true, max: ymdToday(), min: '1990-01-01' });
    const msg = h('div');
    const btn = h('button', { type: 'submit', class: 'primary block' }, 'Continue');
    const form = h('form', {
      async onsubmit(e) {
        e.preventDefault();
        msg.replaceChildren();
        if (!dob.value) { msg.append(banner('error', 'Choose your child\'s date of birth.')); return; }
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/parent/login', { email: email.value, dob: dob.value });
          state.pending = { kind: 'parent', email: email.value.trim(), dob: dob.value, demoCode: r.demoCode };
          go('#/code');
        } catch (ex) {
          msg.append(banner('error', ex.message));
        } finally { btn.disabled = false; }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Your email address'), email, h('div', { class: 'hint' }, 'The email the school has on file for you.')),
    h('div', { class: 'field' }, h('label', { for: 'dob' }, 'Your child\'s date of birth'), dob, h('div', { class: 'hint' }, 'Any one of your children. You\'ll see all of them after signing in.')),
    msg, btn);
    view([
      h('div', { class: 'card' },
        h('h1', {}, 'Book parent-teacher conferences'),
        eventLine(state.me.event),
        form),
      h('p', { class: 'muted small' }, 'Teachers and office staff: ', h('a', { href: '#/staff' }, 'staff sign in')),
    ], { narrow: true });
    email.focus();
  }

  function staffLogin() {
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
    const btn = h('button', { type: 'submit', class: 'primary block' }, 'Email me a sign-in code');
    const msg = h('div');
    view([h('div', { class: 'card' },
      h('h1', {}, 'Staff sign in'),
      h('p', { class: 'muted' }, 'Use your school email address. We\'ll email you a 6-digit code.'),
      h('form', {
        async onsubmit(e) {
          e.preventDefault();
          btn.disabled = true;
          try {
            const r = await api('POST', '/api/staff/login', { email: email.value });
            state.pending = { kind: 'staff', email: email.value.trim(), demoCode: r.demoCode };
            go('#/code');
          } catch (ex) { msg.replaceChildren(banner('error', ex.message)); } finally { btn.disabled = false; }
        },
      }, h('div', { class: 'field' }, h('label', { for: 'email' }, 'School email'), email), msg, btn)),
    h('p', { class: 'small' }, h('a', { href: '#/' }, 'Parent sign in'))], { narrow: true });
    email.focus();
  }

  function codePage() {
    const p = state.pending;
    if (!p) return go('#/');
    const code = h('input', { type: 'text', id: 'code', class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true, 'aria-describedby': 'code-hint' });
    const msg = h('div');
    const btn = h('button', { type: 'submit', class: 'primary block' }, 'Sign in');
    async function resend() {
      msg.replaceChildren();
      try {
        const r = p.kind === 'parent' ? await api('POST', '/api/parent/login', { email: p.email, dob: p.dob }) : await api('POST', '/api/staff/login', { email: p.email });
        if (r.demoCode) { p.demoCode = r.demoCode; return codePage(); }
        msg.append(banner('info', 'If you asked less than 30 seconds ago, use the code from the earlier email. Otherwise a new code is on its way.'));
      } catch (ex) { msg.append(banner('error', ex.message)); }
    }
    view(h('div', { class: 'card' },
      h('h1', {}, 'Check your email'),
      p.demoCode ? banner('warn', h('strong', {}, 'Demo site: '), `your code is ${p.demoCode}. A real site emails it instead.`) : null,
      h('p', {}, p.kind === 'staff' ? 'If ' : 'We sent a 6-digit code to ', h('strong', {}, p.email), p.kind === 'staff' ? ' is a staff address, we sent it a 6-digit code.' : '.'),
      h('form', {
        async onsubmit(e) {
          e.preventDefault();
          msg.replaceChildren();
          btn.disabled = true;
          try {
            await api('POST', `/api/${p.kind}/verify`, { email: p.email, code: code.value });
            state.pending = null;
            await loadMe();
            go('#/');
          } catch (ex) { msg.append(banner('error', ex.message)); code.select(); } finally { btn.disabled = false; }
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'code' }, 'Sign-in code'), code, h('div', { class: 'hint', id: 'code-hint' }, 'The code works for 10 minutes. Check your spam folder if you don\'t see it.')),
      msg, btn),
      h('div', { class: 'row between' }, h('button', { type: 'button', class: 'link', onclick: resend }, 'Send a new code'), h('a', { href: p.kind === 'staff' ? '#/staff' : '#/' }, 'Use a different email'))), { narrow: true });
    code.focus();
  }

  // ---------- family view (parents, and admins acting for a family) ----------
  function parentCtx() {
    return {
      mode: 'parent',
      overviewUrl: '/api/parent/overview',
      slotsUrl: (tid, bid) => `/api/parent/teachers/${tid}/slots${bid ? `?booking=${bid}` : ''}`,
      cancelUrl: (id) => `/api/parent/bookings/${id}/cancel`,
      moveUrl: (id) => `/api/parent/bookings/${id}/move`,
      rerender: () => renderFamily(parentCtx()),
      reload: async () => { state.overview = await api('GET', '/api/parent/overview'); renderFamily(parentCtx()); },
    };
  }

  async function parentPage() {
    spinner();
    state.overview = await api('GET', '/api/parent/overview');
    renderFamily(parentCtx());
  }

  function childById(ov, id) { return ov.children.find((c) => c.id === id); }
  function cartCount(childId) { return state.cart.filter((c) => c.student_id === childId).length; }
  function remaining(ov, childId, ctx) {
    const c = childById(ov, childId);
    return c.limit - c.used - (ctx.mode === 'parent' ? cartCount(childId) : 0);
  }
  // Which child a new meeting should count toward: the one whose card it's under, or a sibling it also covers.
  function pickCounted(ov, t, childId, ctx) {
    if (remaining(ov, childId, ctx) > 0) return childId;
    return t.covered_ids.find((id) => id !== childId && childById(ov, id) && remaining(ov, id, ctx) > 0) || null;
  }

  function renderFamily(ctx) {
    const ov = state.overview;
    const ev = ov.event;
    const out = [];
    if (ctx.mode === 'admin') {
      out.push(h('p', {}, h('a', { href: '#/admin/families' }, '← All families')));
      const g = ov.guardian;
      out.push(h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', {}, h('h1', {}, g.name), h('div', { class: 'muted' }, g.email, ' ', g.email_status !== 'ok' ? h('span', { class: 'badge danger' }, `Email ${g.email_status}`) : null)),
          h('div', { class: 'actions' },
            h('button', { type: 'button', onclick: () => act(() => api('POST', `/api/admin/family/${g.id}/send-schedule`), 'Schedule email queued') }, 'Email their schedule'))),
        h('p', { class: 'small muted' }, 'You are booking on this family\'s behalf. Booking windows and the change cutoff don\'t apply to the office. Every change is logged and the family is emailed.')));
    } else {
      out.push(h('h1', {}, ev ? ev.name : 'Conferences'));
    }
    if (!ev) {
      out.push(banner('info', 'Conference booking has not been set up yet. Please check back later.'));
      return view(out);
    }
    out.push(h('p', { class: 'muted' }, ev.days.map((d) => `${localDayFromYmd(d.day)}`).join(' · '), ` · ${ev.slot_minutes}-minute conferences`));
    if (ctx.mode === 'parent') {
      if (ev.state === 'not_open') out.push(banner('info', h('strong', {}, 'Booking opens '), fmtDateTime(ev.booking_opens_at), '. You can look around now and book then.'));
      else if (ev.state === 'closed') out.push(banner('warn', h('strong', {}, 'Booking is closed. '), `To make changes, contact ${state.me.help}.`));
      else out.push(banner('info', 'Book by ', h('strong', {}, fmtDateTime(ev.booking_closes_at)), `. Each child can have up to ${ev.max_per_child} conferences.`));
      if (ev.parent_changes_locked) out.push(banner('warn', `Online changes closed ${fmtDateTime(ev.change_cutoff_at)}. To change or cancel, contact ${state.me.help} or the teacher.`));
    }

    // Booked conferences
    const sched = h('div', { class: 'card' }, h('h2', {}, ctx.mode === 'parent' ? 'Your conferences' : 'Booked conferences'));
    if (!ov.bookings.length) sched.append(h('p', { class: 'muted' }, 'Nothing booked yet. Pick teachers and times below.'));
    let lastDay = '';
    for (const b of ov.bookings) {
      const dk = dayKey(b.starts_at);
      if (dk !== lastDay) { sched.append(h('div', { class: 'day-label' }, fmtDay(b.starts_at))); lastDay = dk; }
      sched.append(bookingRow(b, ctx, ov));
    }
    if (ov.other_bookings && ov.other_bookings.length) {
      sched.append(h('h3', { class: 'small muted' }, 'Booked by another parent or guardian (counts toward the same limit)'));
      for (const o of ov.other_bookings) {
        sched.append(h('div', { class: 'booking' }, h('div', {},
          h('div', { class: 'booking-time' }, `${fmtDayShort(o.starts_at)}, ${fmtRange(o.starts_at, o.ends_at)}`),
          h('div', {}, `${o.teacher_name} · Room ${o.room}`),
          h('div', { class: 'muted small' }, `About ${o.student_name}, booked by ${o.guardian_name}`))));
      }
    }
    if (ctx.mode === 'parent' && ov.bookings.length) {
      sched.append(h('p', { class: 'small muted' }, 'We emailed you a confirmation with a calendar file. ', ev.location_note ? ev.location_note : ''));
    }
    out.push(sched);

    if (!ov.children.length) out.push(banner('warn', `We couldn't find any students for your account. Please contact ${state.me.help}.`));
    for (const c of ov.children) out.push(childCard(c, ctx, ov));
    if (ctx.mode === 'parent' && state.cart.length) {
      out.push(h('div', { class: 'cartbar' }, h('div', { class: 'cartbar-inner' },
        h('div', {}, h('strong', {}, plural(state.cart.length, 'conference')), ' picked, not booked yet'),
        h('a', { class: 'btn primary', href: '#/parent/review' }, 'Review and confirm'))));
    }
    view(out);
  }

  function bookingRow(b, ctx, ov) {
    const ev = ov.event;
    const canChange = ctx.mode === 'admin' || (!ev.parent_changes_locked);
    const counted = childById(ov, b.counted_student_id);
    return h('div', { class: 'booking' },
      h('div', { class: 'grow' },
        h('div', { class: 'booking-time' }, `${fmtRange(b.starts_at, b.ends_at)}`),
        h('div', {}, h('strong', {}, b.teacher_name), ` · Room ${b.room}`),
        b.co_teachers.length ? h('div', { class: 'small' }, `With ${b.co_teachers.map((c) => c.name).join(', ')}`) : null,
        h('div', { class: 'muted small' }, `About ${b.students.map((s) => s.first_name).join(' and ')}`,
          b.students.length > 1 && counted ? ` (counts toward ${counted.first_name})` : ''),
        b.note ? h('div', { class: 'muted small' }, `Your note: ${b.note}`) : null),
      canChange ? h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'small-btn', onclick: () => { state.picker = { mode: 'move', bookingId: b.id, teacherId: b.teacher_id, childId: b.counted_student_id }; ctx.rerender(); focusPicker(); } }, 'Change time'),
        h('button', { type: 'button', class: 'small-btn danger', onclick: () => cancelBooking(b, ctx) }, 'Cancel')) : null);
  }

  async function cancelBooking(b, ctx) {
    const ok = await confirmBox('Cancel this conference?', `${b.teacher_name}, ${fmtDateTime(b.starts_at)}. The time will be given to another family.`, 'Cancel conference', { danger: true, cancelLabel: 'Keep it' });
    if (!ok) return;
    const r = await act(() => api('POST', ctx.cancelUrl(b.id), ctx.mode === 'admin' ? { reason: 'Cancelled by the office' } : {}), 'Conference cancelled');
    if (r) await ctx.reload();
  }

  function focusPicker() {
    setTimeout(() => { const p = document.getElementById('picker'); if (p) { p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); p.focus(); } }, 50);
  }

  function childCard(c, ctx, ov) {
    const left = c.limit - c.used - (ctx.mode === 'parent' ? cartCount(c.id) : 0);
    const card = h('section', { class: 'card', 'aria-labelledby': `child-${c.id}` },
      h('div', { class: 'child-head' },
        h('h2', { id: `child-${c.id}` }, `${c.first_name} ${c.last_name}`),
        h('span', { class: `counter ${left <= 0 ? 'badge warn' : 'badge accent'}` }, `${c.first_name}: ${c.used} of ${c.limit} conferences booked`,
          ctx.mode === 'parent' && cartCount(c.id) ? ` (+${cartCount(c.id)} picked)` : '')));
    if (ctx.mode === 'admin') {
      card.append(h('div', { class: 'small' }, h('button', { type: 'button', class: 'link', onclick: () => editLimit(c, ctx) }, `Change ${c.first_name}'s limit`)));
    }
    if (!c.teachers.length) card.append(h('p', { class: 'muted' }, `No teachers are listed for ${c.first_name}. Contact ${state.me.help}.`));
    for (const t of c.teachers) card.append(teacherRow(c, t, ctx, ov));
    return card;
  }

  async function editLimit(c, ctx) {
    const input = h('input', { type: 'number', id: 'limit', min: '0', max: '50', value: String(c.limit) });
    await modal({
      title: `Conference limit for ${c.first_name}`,
      body: [h('div', { class: 'field' }, h('label', { for: 'limit' }, 'Maximum conferences'), input, h('div', { class: 'hint' }, `The event default is ${state.overview.event.max_per_child}. Clear the box to go back to the default.`))],
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', submit: true, class: 'primary' }],
      onSubmit: async () => { await api('POST', '/api/admin/limits', { student_id: c.id, max: input.value === '' ? null : Number(input.value) }); },
    }) && (await ctx.reload());
  }

  function teacherRow(c, t, ctx, ov) {
    const ev = ov.event;
    const wrap = h('div', { class: 'teacher' });
    const info = h('div', { class: 'grow' },
      h('div', { class: 'teacher-name' }, t.name),
      h('div', { class: 'teacher-meta' }, `Room ${t.room}`, t.sections.length ? ` · ${t.sections.join(', ')}` : ''),
      t.co_teachers.length ? h('div', { class: 'small' }, `Meets together with ${t.co_teachers.map((x) => `${x.name} (Room ${x.room})`).join(', ')}`) : null,
      t.shared_with.length ? h('div', { class: 'small muted' }, `Also teaches ${t.shared_with.join(' and ')}. One meeting covers ${t.shared_with.length > 1 ? 'all of them' : 'both'}.`) : null);
    const side = h('div', { class: 'actions' });
    const inCart = ctx.mode === 'parent' ? state.cart.find((x) => x.teacher_id === t.teacher_id) : null;
    const pickerOpen = state.picker && state.picker.teacherId === t.teacher_id && state.picker.childId === c.id && state.picker.mode === 'book';
    if (t.booking) {
      info.append(h('div', {}, h('span', { class: 'badge ok' }, `Booked: ${fmtDayShort(t.booking.starts_at)}, ${fmtTime(t.booking.starts_at)}`),
        t.booking.counted_student_id !== c.id ? h('span', { class: 'small muted' }, ` (counts toward ${(childById(ov, t.booking.counted_student_id) || {}).first_name || 'a sibling'})`) : null));
    } else if (inCart) {
      info.append(h('div', {}, h('span', { class: 'badge accent' }, `Picked: ${fmtDayShort(inCart.starts_at)}, ${fmtTime(inCart.starts_at)}`), ' ',
        h('button', { type: 'button', class: 'link small', onclick: () => { state.cart = state.cart.filter((x) => x !== inCart); ctx.rerender(); } }, 'Remove')));
    } else if (ctx.mode === 'parent' && ev.state !== 'open') {
      // Banner at the top explains.
    } else if (t.open_count === 0) {
      info.append(h('div', { class: 'small' }, h('span', { class: 'badge warn' }, 'This teacher is fully booked')));
      if (ctx.mode === 'parent') {
        if (t.waitlisted) info.append(h('div', { class: 'small ok' }, `We let ${t.name} know you'd like to meet.`));
        else side.append(h('button', { type: 'button', onclick: () => tryToBook(c, t, ctx) }, 'Let the teacher know I\'d like to meet'));
      }
    } else {
      const counted = pickCounted(ov, t, c.id, ctx);
      if (!counted) info.append(h('div', { class: 'small muted' }, `${c.first_name} has reached the limit of ${c.limit} conferences.`));
      else side.append(h('button', {
        type: 'button', class: pickerOpen ? '' : 'primary', 'aria-expanded': pickerOpen ? 'true' : 'false',
        onclick: () => { state.picker = pickerOpen ? null : { mode: 'book', teacherId: t.teacher_id, childId: c.id }; ctx.rerender(); if (!pickerOpen) focusPicker(); },
      }, pickerOpen ? 'Close' : 'Choose a time'));
    }
    wrap.append(h('div', { class: 'row between' }, info, side));
    const movingHere = state.picker && state.picker.mode === 'move' && state.picker.teacherId === t.teacher_id && t.booking && state.picker.bookingId === t.booking.id && state.picker.childId === c.id;
    if (pickerOpen || movingHere) wrap.append(slotPicker(c, t, ctx, ov));
    return wrap;
  }

  async function tryToBook(c, t, ctx) {
    const note = h('textarea', { id: 'tnote', maxlength: '500', placeholder: 'For example: Any time after 4pm works' });
    const ok = await modal({
      title: `Ask ${t.name} for a time`,
      body: [h('p', {}, `${t.name} has no open times left. We'll let them know you'd like to meet about ${c.first_name}, and they can contact you.`),
        h('div', { class: 'field' }, h('label', { for: 'tnote' }, 'Note for the teacher (optional)'), note)],
      actions: [{ label: 'Cancel', value: null }, { label: 'Send', submit: true, class: 'primary' }],
      onSubmit: async () => { await api('POST', '/api/parent/attempts', { teacher_id: t.teacher_id, student_id: c.id, note: note.value }); },
    });
    if (ok) { toast(`${t.name} will see your request`); await ctx.reload(); }
  }

  function slotPicker(c, t, ctx, ov) {
    const p = state.picker;
    const box = h('div', { id: 'picker', tabindex: '-1', 'aria-label': `Times for ${t.name}` }, h('div', { class: 'spinner' }, 'Loading times…'));
    const bookingId = p.mode === 'move' ? p.bookingId : null;
    api('GET', ctx.slotsUrl(t.teacher_id, bookingId)).then(({ options }) => {
      box.replaceChildren();
      if (p.mode === 'move') box.append(h('p', { class: 'small' }, h('strong', {}, 'Pick a new time. '), 'Your current time is highlighted.'));
      // Times already picked (not booked) with other teachers count as busy.
      const cartOthers = ctx.mode === 'parent' ? state.cart.filter((x) => x.teacher_id !== t.teacher_id) : [];
      let lastDay = '';
      let grid = null;
      let anyOpen = false;
      for (const o of options) {
        const dk = dayKey(o.starts_at);
        if (dk !== lastDay) {
          box.append(h('div', { class: 'day-label' }, fmtDay(o.starts_at)));
          grid = h('div', { class: 'slots', role: 'group', 'aria-label': fmtDay(o.starts_at) });
          box.append(grid);
          lastDay = dk;
        }
        let status = o.status;
        let adjacent = o.adjacent;
        if (status === 'open' && cartOthers.some((x) => x.starts_at < o.ends_at && o.starts_at < x.ends_at)) status = 'conflict';
        if (status === 'open' && cartOthers.some((x) => x.ends_at === o.starts_at || x.starts_at === o.ends_at)) adjacent = true;
        const label = { full: 'Full', conflict: 'You\'re busy', current: 'Current', open: adjacent ? 'Back-to-back' : '' }[status];
        if (status === 'open') anyOpen = true;
        grid.append(h('button', {
          type: 'button', class: `slot ${status}`, disabled: status !== 'open',
          'aria-label': `${fmtTime(o.starts_at)}${label ? `, ${label}` : ''}`,
          onclick: () => chooseSlot(c, t, o, adjacent, ctx, ov),
        }, h('span', {}, fmtTime(o.starts_at)), label ? h('span', { class: 'slot-sub' }, label) : null));
      }
      if (!anyOpen) box.append(banner('warn', 'There are no open times left with this teacher.'));
      box.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'small-btn', onclick: () => { state.picker = null; ctx.rerender(); } }, 'Close')));
    }).catch((e) => box.replaceChildren(banner('error', e.message)));
    return box;
  }

  async function chooseSlot(c, t, o, adjacent, ctx, ov) {
    const p = state.picker;
    if (adjacent && p.mode === 'book') {
      const keep = await confirmBox('Back-to-back conferences',
        `Warning! Each conference is ${ov.event.slot_minutes} minutes and traveling to another room will take up meeting time. We recommend switching to another time.`,
        'Keep this time', { cancelLabel: 'Pick another time' });
      if (!keep) return;
    }
    if (p.mode === 'move') {
      const b = ov.bookings.find((x) => x.id === p.bookingId);
      const ok = await confirmBox('Change your conference time?', `${t.name}: from ${fmtDateTime(b.starts_at)} to ${fmtDateTime(o.starts_at)}.`, 'Change time');
      if (!ok) return;
      try {
        await api('POST', ctx.moveUrl(p.bookingId), { starts_at: o.starts_at });
        state.picker = null;
        toast('Conference time changed. We emailed you the new schedule.');
      } catch (e) {
        await modal({ title: 'That time isn\'t available', body: [h('p', {}, e.message)], actions: [{ label: 'OK', submit: true, class: 'primary' }] });
      }
      return ctx.reload();
    }
    const counted = pickCounted(ov, t, c.id, ctx);
    if (ctx.mode === 'admin') {
      const ok = await confirmBox('Book this conference?', `${t.name} with ${ov.guardian.name}, ${fmtDateTime(o.starts_at)}, about ${childById(ov, counted).first_name}. The family will be emailed.`, 'Book');
      if (!ok) return;
      await act(() => api('POST', '/api/admin/bookings', { teacher_id: t.teacher_id, starts_at: o.starts_at, student_id: counted, guardian_id: ov.guardian.id }), 'Booked and emailed');
      state.picker = null;
      return ctx.reload();
    }
    state.cart = state.cart.filter((x) => x.teacher_id !== t.teacher_id);
    state.cart.push({
      teacher_id: t.teacher_id, teacher_name: t.name, room: t.room, co_teachers: t.co_teachers,
      starts_at: o.starts_at, ends_at: o.ends_at, student_id: counted, covered_ids: t.covered_ids, note: '', adjacent,
    });
    state.cart.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    state.picker = null;
    toast(`${t.name} at ${fmtTime(o.starts_at)} added. Review and confirm when you're done.`);
    ctx.rerender();
  }

  // ---------- review and confirm ----------
  async function reviewPage() {
    if (!state.overview) state.overview = await api('GET', '/api/parent/overview');
    const ov = state.overview;
    const out = [h('p', {}, h('a', { href: '#/parent' }, '← Back to teachers'))];
    if (state.results) {
      out.push(resultsView(ov));
      return view(out, { narrow: true });
    }
    if (!state.cart.length) return go('#/parent');
    out.push(h('h1', {}, 'Review your conferences'));
    out.push(h('p', { class: 'muted' }, 'Nothing is booked until you tap Confirm.'));
    const problems = [];
    for (const c of ov.children) {
      const n = c.used + state.cart.filter((x) => x.student_id === c.id).length;
      if (n > c.limit) problems.push(`${c.first_name} would have ${n} conferences, but the limit is ${c.limit}. Remove one or count it toward a sibling.`);
    }
    for (const it of state.cart) {
      const covered = it.covered_ids.map((id) => childById(ov, id)).filter(Boolean);
      const note = h('textarea', { id: `note-${it.teacher_id}`, maxlength: '500', placeholder: 'For example: I\'d like to discuss reading', oninput: (e) => { it.note = e.target.value; } });
      note.value = it.note;
      const sel = covered.length > 1 ? h('select', {
        id: `count-${it.teacher_id}`,
        onchange: (e) => { it.student_id = Number(e.target.value); reviewPage(); },
      }, covered.map((c) => h('option', { value: String(c.id), selected: c.id === it.student_id }, c.first_name))) : null;
      out.push(h('div', { class: 'card' },
        h('div', { class: 'row between' },
          h('div', {},
            h('div', { class: 'booking-time' }, `${fmtDay(it.starts_at)}, ${fmtRange(it.starts_at, it.ends_at)}`),
            h('div', {}, h('strong', {}, it.teacher_name), ` · Room ${it.room}`),
            it.co_teachers.length ? h('div', { class: 'small' }, `With ${it.co_teachers.map((x) => x.name).join(', ')}`) : null,
            h('div', { class: 'muted small' }, `About ${covered.map((c) => c.first_name).join(' and ')}`)),
          h('button', { type: 'button', class: 'small-btn danger', onclick: () => { state.cart = state.cart.filter((x) => x !== it); reviewPage(); } }, 'Remove')),
        it.adjacent ? banner('warn', 'Back-to-back with another conference. Traveling to another room will take up meeting time.') : null,
        sel ? h('div', { class: 'field' }, h('label', { for: sel.id }, 'Count this conference toward'), sel) : null,
        h('div', { class: 'field' }, h('label', { for: note.id }, 'Note for the teacher (optional)'), note)));
    }
    if (problems.length) out.push(banner('error', problems.join(' ')));
    const btn = h('button', { type: 'button', class: 'primary block', disabled: problems.length > 0, onclick: confirmCart }, `Confirm ${plural(state.cart.length, 'conference')}`);
    out.push(btn);
    view(out, { narrow: true });

    async function confirmCart() {
      btn.disabled = true;
      btn.textContent = 'Booking…';
      try {
        const r = await api('POST', '/api/parent/bookings', {
          items: state.cart.map((x) => ({ teacher_id: x.teacher_id, starts_at: x.starts_at, student_id: x.student_id, note: x.note })),
        });
        state.results = r.results.map((res) => ({ ...res, item: state.cart.find((x) => x.teacher_id === res.teacher_id) }));
        state.cart = [];
        state.overview = await api('GET', '/api/parent/overview');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Try again';
        out.push(banner('error', e.message));
        view(out, { narrow: true });
        return;
      }
      reviewPage();
    }
  }

  function resultsView(ov) {
    const res = state.results;
    const ok = res.filter((r) => r.ok);
    const bad = res.filter((r) => !r.ok);
    const box = h('div', {});
    if (ok.length) {
      box.append(h('div', { class: 'card' },
        h('h1', {}, ok.length === res.length ? 'You\'re booked!' : `${plural(ok.length, 'conference')} booked`),
        h('p', {}, 'We emailed you a confirmation with a calendar file.'),
        h('ul', { class: 'list-plain' }, ok.map((r) => h('li', {}, h('strong', {}, `${fmtDayShort(r.item.starts_at)}, ${fmtRange(r.item.starts_at, r.item.ends_at)}`), ` · ${r.item.teacher_name}, Room ${r.item.room}`)))));
    }
    for (const r of bad) {
      const it = r.item;
      const alts = r.alternatives || [];
      box.append(h('div', { class: 'card' },
        h('h2', {}, `${it.teacher_name}: not booked`),
        banner('error', r.message),
        alts.length ? h('p', {}, 'Next open times:') : null,
        alts.length ? h('div', { class: 'slots' }, alts.map((a) => h('button', {
          type: 'button', class: 'slot open',
          onclick: () => { state.results = null; state.cart.push({ ...it, starts_at: a.starts_at, ends_at: a.ends_at, adjacent: false }); state.cart.sort((x, y) => x.starts_at.localeCompare(y.starts_at)); reviewPage(); },
        }, fmtTime(a.starts_at)))) : null,
        r.code === 'SLOT_TAKEN' && !alts.length ? h('button', {
          type: 'button',
          onclick: async () => {
            const c = childById(ov, it.student_id);
            const t = c && c.teachers.find((x) => x.teacher_id === it.teacher_id);
            if (t) await tryToBook(c, t, { reload: async () => { state.overview = await api('GET', '/api/parent/overview'); } });
          },
        }, 'Let the teacher know I\'d like to meet') : null));
    }
    box.append(h('button', { type: 'button', class: 'primary block', onclick: () => { state.results = null; go('#/parent'); } }, 'Done'));
    return box;
  }

  // ---------- teacher schedule (teachers, and admins viewing a teacher) ----------
  async function teacherPage() {
    spinner();
    const data = await api('GET', '/api/teacher/schedule');
    renderSchedule({
      mode: 'teacher', teacher: data.teacher, event: data.event, slots: data.slots, attempts: data.attempts,
      reload: teacherPage,
      urls: {
        block: (id, on) => `/api/teacher/slots/${id}/${on ? 'block' : 'unblock'}`,
        cancel: (id) => `/api/teacher/bookings/${id}/cancel`,
        move: (id) => `/api/teacher/bookings/${id}/move`,
        add: '/api/teacher/bookings',
        roster: '/api/teacher/roster',
        attempt: (id) => `/api/teacher/attempts/${id}`,
        csv: '/api/teacher/export.csv',
      },
    });
  }

  function renderSchedule(ctx) {
    const { teacher, event: ev, slots, attempts } = ctx;
    const out = [];
    if (ctx.mode === 'admin') out.push(h('p', { class: 'no-print' }, h('a', { href: '#/admin/teachers' }, '← All teachers')));
    out.push(h('div', { class: 'row between' },
      h('div', {}, h('h1', {}, ctx.mode === 'admin' ? teacher.name : 'Your conference schedule'),
        h('p', { class: 'muted' }, `${teacher.name} · Room ${teacher.room}`, ev ? ` · ${ev.name}` : '')),
      h('div', { class: 'actions no-print' },
        h('button', { type: 'button', onclick: () => window.print() }, 'Print'),
        ev && ctx.urls.csv ? h('a', { class: 'btn', href: ctx.urls.csv, download: '' }, 'Export CSV') : null,
        ctx.mode === 'admin' ? h('button', { type: 'button', class: 'danger', onclick: () => teacherUnavailable(ctx) }, 'Teacher unavailable…') : null)));
    if (!ev) { out.push(banner('info', 'No conference event has been set up yet.')); return view(out); }
    const canBlock = ctx.mode === 'admin' || ev.state === 'not_open';
    if (ctx.mode === 'teacher') {
      out.push(banner('info', canBlock
        ? 'Booking hasn\'t opened yet, so you can block times you\'re not available (lunch, a meeting).'
        : 'Booking is open, so times can no longer be blocked here. Ask the office if you need to block a time.'));
    }
    const booked = slots.filter((s) => s.booking).length;
    out.push(h('p', {}, h('strong', {}, `${booked} of ${slots.length}`), ' times booked',
      attempts.filter((a) => a.status === 'new').length ? ` · ${plural(attempts.filter((a) => a.status === 'new').length, 'parent')} waiting to hear from you` : ''));

    const card = h('div', { class: 'card' });
    let lastDay = '';
    let tbody = null;
    for (const s of slots) {
      const dk = dayKey(s.starts_at);
      if (dk !== lastDay) {
        lastDay = dk;
        tbody = h('tbody');
        card.append(h('h2', { class: lastDay && card.childNodes.length ? 'page-break' : '' }, fmtDay(s.starts_at)),
          h('div', { class: 'table-wrap' }, h('table', { class: 'stack-sm' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Student'), h('th', {}, 'Parent / guardian'), h('th', {}, 'Parent email'), h('th', {}, 'Note from parent'), h('th', { class: 'no-print' }, h('span', { class: 'sr-only' }, 'Actions')))),
            tbody)));
      }
      tbody.append(scheduleRow(s, ctx, canBlock));
    }
    out.push(card);

    // "Tried to book" list
    const tried = h('div', { class: 'card' }, h('h2', {}, `Parents who tried to book (${attempts.length})`));
    if (!attempts.length) tried.append(h('p', { class: 'muted' }, 'No one yet. Parents who find your schedule full can ask you for a time, and they\'ll show up here.'));
    else {
      tried.append(h('div', { class: 'table-wrap' }, h('table', { class: 'stack-sm' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Student'), h('th', {}, 'Parent / guardian'), h('th', {}, 'Email'), h('th', {}, 'When'), h('th', {}, 'Note'), h('th', {}, 'Status'))),
        h('tbody', {}, attempts.map((a) => h('tr', {},
          h('td', { 'data-label': 'Student' }, a.student_name, a.main_teacher !== teacher.name ? h('div', { class: 'small muted' }, `Meeting with ${a.main_teacher}`) : null),
          h('td', { 'data-label': 'Parent' }, a.guardian_name),
          h('td', { 'data-label': 'Email' }, h('a', { href: `mailto:${a.guardian_email}` }, a.guardian_email)),
          h('td', { 'data-label': 'When' }, fmtDateTime(a.created_at)),
          h('td', { 'data-label': 'Note' }, a.note || ''),
          h('td', { 'data-label': 'Status' }, h('select', {
            'aria-label': `Status for ${a.student_name}`,
            onchange: async (e) => { if (await act(() => api('POST', ctx.urls.attempt(a.id), { status: e.target.value }), 'Saved')) ctx.reload(); },
          }, [['new', 'Needs follow-up'], ['contacted', 'Contacted'], ['scheduled', 'Scheduled another time']].map(([v, l]) => h('option', { value: v, selected: a.status === v }, l))))))))));
    }
    out.push(tried);
    view(out);
  }

  function scheduleRow(s, ctx, canBlock) {
    const time = h('td', { class: 'cell-time nowrap', 'data-label': 'Time' }, fmtRange(s.starts_at, s.ends_at));
    const actions = h('td', { class: 'no-print' }, h('div', { class: 'actions' }));
    const a = actions.firstChild;
    if (s.booking) {
      const b = s.booking;
      if (b.can_change || ctx.mode === 'admin') {
        if (b.can_change) a.append(h('button', { type: 'button', class: 'small-btn', onclick: () => moveDialog(s, ctx) }, 'Move'));
        a.append(h('button', { type: 'button', class: 'small-btn danger', onclick: () => staffCancel(s, ctx) }, 'Cancel'));
      }
      const extra = [];
      if (b.role === 'co') extra.push(`Co-taught meeting led by ${b.main_teacher}`);
      if (b.co_teachers.length) extra.push(`With ${b.co_teachers.join(', ')}`);
      return h('tr', {}, time,
        h('td', { 'data-label': 'Student' }, b.students.join(', '), extra.length ? h('div', { class: 'small muted' }, extra.join(' · ')) : null),
        h('td', { 'data-label': 'Parent' }, b.guardian_name, b.email_status !== 'ok' ? h('div', {}, h('span', { class: 'badge danger' }, `Email ${b.email_status}`)) : null),
        h('td', { 'data-label': 'Email' }, h('a', { href: `mailto:${b.guardian_email}` }, b.guardian_email)),
        h('td', { 'data-label': 'Note' }, b.note || ''),
        actions);
    }
    if (s.status === 'blocked') {
      if (canBlock) a.append(h('button', { type: 'button', class: 'small-btn', onclick: () => setBlock(s, false, ctx) }, 'Unblock'));
      return h('tr', { class: 'is-blocked' }, time, h('td', { colspan: '4' }, `Blocked${s.block_reason ? `: ${s.block_reason}` : ''}`), actions);
    }
    a.append(h('button', { type: 'button', class: 'small-btn', onclick: () => addParentDialog(s, ctx) }, 'Add parent'));
    if (canBlock) a.append(h('button', { type: 'button', class: 'small-btn', onclick: () => setBlock(s, true, ctx) }, 'Block'));
    return h('tr', { class: 'is-open' }, time, h('td', { colspan: '4' }, '(open)'), actions);
  }

  async function setBlock(s, on, ctx) {
    let reason = '';
    if (on) {
      const input = h('input', { type: 'text', id: 'reason', maxlength: '100', placeholder: 'Lunch, meeting…' });
      const v = await modal({
        title: `Block ${fmtTime(s.starts_at)}?`, body: [h('div', { class: 'field' }, h('label', { for: 'reason' }, 'Reason (only staff see this)'), input)],
        actions: [{ label: 'Cancel', value: null }, { label: 'Block', submit: true, class: 'primary', value: 'ok' }],
      });
      if (!v) return;
      reason = input.value;
    }
    if (await act(() => api('POST', ctx.urls.block(s.id, on), { reason }), on ? 'Time blocked' : 'Time unblocked')) ctx.reload();
  }

  async function staffCancel(s, ctx) {
    const input = h('input', { type: 'text', id: 'reason', maxlength: '200', placeholder: 'For example: I\'m out sick that day' });
    const v = await modal({
      title: 'Cancel this conference?',
      body: [h('p', {}, `${s.booking.students.join(', ')} with ${s.booking.guardian_name}, ${fmtDateTime(s.starts_at)}. The family will be emailed and can pick a new time.`),
        h('div', { class: 'field' }, h('label', { for: 'reason' }, 'Reason for the family (optional)'), input)],
      actions: [{ label: 'Keep it', value: null }, { label: 'Cancel conference', submit: true, class: 'danger solid', value: 'ok' }],
    });
    if (!v) return;
    if (await act(() => api('POST', ctx.urls.cancel(s.booking.id), { reason: input.value }), 'Cancelled. The family was emailed.')) ctx.reload();
  }

  async function moveDialog(s, ctx) {
    const open = ctx.slots.filter((x) => x.status === 'open' && !x.booking);
    if (!open.length) { await confirmBox('No open times', 'There are no open times to move this conference to.', 'OK'); return; }
    const sel = h('select', { id: 'newtime' }, open.map((o) => h('option', { value: o.starts_at }, `${fmtDayShort(o.starts_at)}, ${fmtTime(o.starts_at)}`)));
    const ok = await modal({
      title: 'Move conference',
      body: [h('p', {}, `${s.booking.students.join(', ')} with ${s.booking.guardian_name}, now at ${fmtDateTime(s.starts_at)}.`),
        h('div', { class: 'field' }, h('label', { for: 'newtime' }, 'New time'), sel),
        h('p', { class: 'small muted' }, 'The family will be emailed the new time.')],
      actions: [{ label: 'Cancel', value: null }, { label: 'Move', submit: true, class: 'primary' }],
      onSubmit: async () => { await api('POST', ctx.urls.move(s.booking.id), { starts_at: sel.value }); },
    });
    if (ok) { toast('Moved. The family was emailed.'); ctx.reload(); }
  }

  async function addParentDialog(s, ctx) {
    let roster;
    try { roster = (await api('GET', ctx.urls.roster)).students; } catch (e) { await act(() => Promise.reject(e)); return; }
    let chosen = null;
    const search = h('input', { type: 'search', id: 'rsearch', placeholder: 'Type a student or parent name', autocomplete: 'off' });
    const list = h('div', { class: 'stack' });
    const guardians = h('div');
    const note = h('textarea', { id: 'anote', maxlength: '500' });
    function draw() {
      const q = search.value.trim().toLowerCase();
      const matches = roster.filter((st) => !q || `${st.first_name} ${st.last_name} ${st.guardians.map((g) => g.name).join(' ')}`.toLowerCase().includes(q)).slice(0, 8);
      list.replaceChildren(...matches.map((st) => h('label', { class: 'row' },
        h('input', { type: 'radio', name: 'student', value: String(st.id), checked: chosen === st, onchange: () => { chosen = st; drawGuardians(); } }),
        h('span', {}, `${st.first_name} ${st.last_name}`, h('span', { class: 'muted small' }, ` · ${st.guardians.map((g) => g.name).join(', ')}`)))));
      if (!matches.length) list.append(h('p', { class: 'muted' }, 'No matching students.'));
    }
    function drawGuardians() {
      guardians.replaceChildren();
      if (!chosen) return;
      guardians.append(h('p', { class: 'hint' }, 'Which parent or guardian is coming?'));
      chosen.guardians.forEach((g, i) => guardians.append(h('label', { class: 'row' },
        h('input', { type: 'radio', name: 'guardian', value: String(g.id), checked: i === 0 }),
        h('span', {}, g.name, h('span', { class: 'muted small' }, ` · ${g.email}`)))));
    }
    search.addEventListener('input', draw);
    draw();
    const ok = await modal({
      title: `Add a parent at ${fmtTime(s.starts_at)}`,
      body: [h('div', { class: 'field' }, h('label', { for: 'rsearch' }, 'Student'), search), list, guardians,
        h('div', { class: 'field' }, h('label', { for: 'anote' }, 'Note (optional)'), note),
        h('p', { class: 'small muted' }, 'The parent gets the same confirmation email, and this counts toward the child\'s limit.')],
      actions: [{ label: 'Cancel', value: null }, { label: 'Book', submit: true, class: 'primary' }],
      onSubmit: async () => {
        if (!chosen) throw new Error('Choose a student.');
        const g = document.querySelector('input[name=guardian]:checked');
        if (!g) throw new Error('Choose a parent or guardian.');
        const body = { starts_at: s.starts_at, student_id: chosen.id, guardian_id: Number(g.value), note: note.value };
        if (ctx.mode === 'admin') body.teacher_id = ctx.teacher.id;
        await api('POST', ctx.urls.add, body);
      },
    });
    if (ok) { toast('Booked. The family was emailed.'); ctx.reload(); }
  }

  async function teacherUnavailable(ctx) {
    const input = h('input', { type: 'text', id: 'ureason', maxlength: '100', value: `${ctx.teacher.name} is unavailable` });
    const n = ctx.slots.filter((s) => s.booking && s.booking.role === 'primary').length + ctx.slots.filter((s) => s.booking && s.booking.role === 'co').length;
    const ok = await modal({
      title: `Mark ${ctx.teacher.name} unavailable?`,
      body: [h('p', {}, `This cancels all ${plural(n, 'conference')} that include ${ctx.teacher.name}, emails each family, and blocks the rest of their times. It can't be undone automatically.`),
        h('div', { class: 'field' }, h('label', { for: 'ureason' }, 'Reason for families'), input)],
      actions: [{ label: 'Cancel', value: null }, { label: 'Cancel all and email families', submit: true, class: 'danger solid' }],
      onSubmit: async () => api('POST', `/api/admin/teachers/${ctx.teacher.id}/unavailable`, { reason: input.value }),
    });
    if (ok) { toast(`${plural(ok.cancelled, 'conference')} cancelled, ${plural(ok.blocked, 'time')} blocked`); ctx.reload(); }
  }

  // ---------- admin ----------
  const ADMIN_TABS = [
    ['dashboard', 'Dashboard'], ['upload', 'Upload data'], ['event', 'Event setup'], ['families', 'Families'],
    ['teachers', 'Teachers'], ['print', 'Print & export'], ['emails', 'Emails'], ['audit', 'Activity log'], ['settings', 'Settings'],
  ];
  function adminTabs(current) {
    return h('nav', { class: 'tabs no-print', 'aria-label': 'Admin' }, ADMIN_TABS.map(([k, l]) => h('a', { href: `#/admin/${k}`, 'aria-current': k === current ? 'page' : null }, l)));
  }

  async function adminPage(tab, arg) {
    spinner();
    const pages = { dashboard: adminDashboard, upload: adminUpload, event: adminEvent, families: adminFamilies, family: adminFamily, teachers: adminTeachers, teacher: adminTeacher, print: adminPrint, emails: adminEmails, audit: adminAudit, settings: adminSettings };
    const fn = pages[tab] || adminDashboard;
    const tabKey = { family: 'families', teacher: 'teachers' }[tab] || tab;
    const content = await fn(arg);
    if (content === undefined) return; // page rendered itself
    view([adminTabs(tabKey), content]);
  }

  async function adminDashboard() {
    const d = await api('GET', '/api/admin/dashboard');
    if (!d.event) {
      return h('div', { class: 'card' }, h('h1', {}, 'Welcome'), h('p', {}, 'Three steps to get started:'),
        h('ol', {}, h('li', {}, h('a', { href: '#/admin/upload' }, 'Upload the SIS reports')), h('li', {}, h('a', { href: '#/admin/event' }, 'Set up the conference event')), h('li', {}, 'Send the booking-open email from this page')));
    }
    const ev = d.event;
    const stateLabel = { not_open: `Booking opens ${fmtDateTime(ev.booking_opens_at)}`, open: `Booking is open until ${fmtDateTime(ev.booking_closes_at)}`, closed: 'Booking is closed' }[ev.state];
    const totalSlots = d.teachers.reduce((a, t) => a + t.total, 0);
    const bookedSlots = d.teachers.reduce((a, t) => a + t.booked, 0);
    const box = h('div', {});
    box.append(h('h1', {}, ev.name), h('p', { class: 'muted' }, ev.days.map((x) => `${localDayFromYmd(x.day)}, ${hm12(x.start_time)}–${hm12(x.end_time)}`).join(' · '), ' · ', stateLabel));
    if (!d.open_email_sent_at) {
      box.append(banner('info', h('strong', {}, 'Ready to invite families? '), `This emails all ${d.counts.guardians} parents and guardians the link, sign-in steps and deadline. `,
        h('button', { type: 'button', class: 'primary small-btn', onclick: sendOpen }, 'Send booking-open email')));
    } else {
      box.append(h('p', { class: 'small muted' }, `Booking-open email sent ${fmtDateTime(d.open_email_sent_at)}. `, h('button', { type: 'button', class: 'link', onclick: sendOpen }, 'Send again')));
    }
    async function sendOpen() {
      const ok = await confirmBox('Email every family?', `This sends the booking-open email to ${d.counts.guardians} parents and guardians now.`, 'Send emails');
      if (ok && await act(() => api('POST', '/api/admin/event/send-open-email'), 'Emails queued')) route();
    }
    box.append(h('div', { class: 'stats' },
      stat(d.counts.bookings, 'conferences booked'), stat(`${totalSlots ? Math.round((bookedSlots / totalSlots) * 100) : 0}%`, 'of teacher time booked'),
      stat(d.unbooked.length, 'families with nothing booked'), stat(d.teachers.reduce((a, t) => a + t.tried_open, 0), '"tried to book" requests open'),
      stat(d.badEmails.length, 'families with email problems')));
    if (d.stranded.length) {
      box.append(h('div', { class: 'card' }, h('h2', {}, 'Bookings that need a look'),
        h('ul', { class: 'list-plain' }, d.stranded.map((s) => h('li', {}, h('strong', {}, `${fmtDayShort(s.starts_at)} ${fmtTime(s.starts_at)}`), ` · ${s.teacher_name} · ${s.student_name} (${s.guardian_name}) · `, h('span', { class: 'badge warn' }, s.reason))))));
    }
    box.append(h('div', { class: 'card' }, h('h2', {}, 'Teachers'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Teacher'), h('th', { class: 'num' }, 'Booked'), h('th', { class: 'num' }, 'Open'), h('th', { class: 'num hide-sm' }, 'Blocked'), h('th', { class: 'hide-sm' }, ''), h('th', { class: 'num' }, 'Tried to book'))),
        h('tbody', {}, d.teachers.map((t) => h('tr', {},
          h('td', {}, h('a', { href: `#/admin/teacher/${t.id}` }, t.name), t.active ? null : h('span', { class: 'badge warn' }, ' not in upload'), h('div', { class: 'small muted' }, `Room ${t.room}`)),
          h('td', { class: 'num' }, t.booked), h('td', { class: 'num' }, t.open), h('td', { class: 'num hide-sm' }, t.blocked),
          h('td', { class: 'hide-sm' }, h('div', { class: 'meter', role: 'img', 'aria-label': `${t.booked} of ${t.total} booked` }, meterFill(t.total ? t.booked / t.total : 0))),
          h('td', { class: 'num' }, t.tried ? h('span', { class: t.tried_open ? 'badge warn' : 'badge' }, String(t.tried)) : '0'))))))));
    box.append(h('div', { class: 'card' }, h('h2', {}, `Families with nothing booked (${d.unbooked.length})`),
      d.unbooked.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'stack-sm' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Parent / guardian'), h('th', {}, 'Email'), h('th', {}, 'Children'))),
        h('tbody', {}, d.unbooked.map((u) => h('tr', {},
          h('td', { 'data-label': 'Parent' }, h('a', { href: `#/admin/family/${u.id}` }, u.name)),
          h('td', { 'data-label': 'Email' }, u.email, u.email_status !== 'ok' ? h('span', { class: 'badge danger' }, ` ${u.email_status}`) : null),
          h('td', { 'data-label': 'Children' }, u.children)))))) : h('p', { class: 'muted' }, 'Every family has at least one conference.')));
    if (d.badEmails.length) {
      box.append(h('div', { class: 'card' }, h('h2', {}, 'Emails that failed or bounced'), h('p', { class: 'small muted' }, 'Call these families, or fix their email in the SIS and re-upload.'),
        h('ul', { class: 'list-plain' }, d.badEmails.map((g) => h('li', {}, h('a', { href: `#/admin/family/${g.id}` }, g.name), ` · ${g.email} · `, h('span', { class: 'badge danger' }, g.email_status), g.email_status_detail ? h('span', { class: 'small muted' }, ` ${g.email_status_detail}`) : null)))));
    }
    return box;
  }
  function stat(n, label) { return h('div', { class: 'stat' }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label)); }
  function meterFill(frac) { const s = h('span'); s.style.width = `${Math.round(frac * 100)}%`; return s; }

  async function adminUpload() {
    const files = {};
    const KEYS = [
      ['students', 'Upload 1: Students and parents', 'SIS ID, First Name, Last Name, Date of Birth, Primary Parent Name, Primary Parent Email, Secondary Parent Name, Secondary Parent Email'],
      ['schedules', 'Upload 2: Student schedules', 'SIS ID, Course Section'],
      ['teachers', 'Upload 3: Teacher sections', 'Teacher Name, Teacher Email, Course Section, Room Number'],
      ['supports', 'Upload 4: Special education and ELL support (optional)', 'SIS ID, Support Type (SPED or ELL), Support Teacher Email, Co-taught Section'],
    ];
    const report = h('div');
    const checkBtn = h('button', { type: 'button', class: 'primary', onclick: () => run(false) }, 'Check files');
    const importBtn = h('button', { type: 'button', disabled: true, onclick: () => run(true) }, 'Import');
    const inputs = KEYS.map(([k, label, cols]) => {
      const inp = h('input', { type: 'file', id: `f-${k}`, accept: '.csv,.xlsx' });
      inp.addEventListener('change', () => { importBtn.disabled = true; report.replaceChildren(); });
      files[k] = inp;
      return h('div', { class: 'field' }, h('label', { for: `f-${k}` }, label), inp, h('div', { class: 'hint' }, `Columns: ${cols}`));
    });
    async function readFile(f) {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { name: f.name, data: btoa(bin) };
    }
    async function run(doImport) {
      const payload = {};
      for (const [k] of KEYS) if (files[k].files[0]) payload[k] = await readFile(files[k].files[0]);
      checkBtn.disabled = true; importBtn.disabled = true;
      report.replaceChildren(h('div', { class: 'spinner' }, doImport ? 'Importing…' : 'Checking every row…'));
      try {
        const r = await api('POST', `/api/admin/upload/${doImport ? 'import' : 'validate'}`, { files: payload });
        report.replaceChildren(uploadReport(r));
        importBtn.disabled = !(r.errors.length === 0 && !r.imported);
        if (r.imported) toast('Imported');
      } catch (e) {
        report.replaceChildren(banner('error', e.message));
      } finally { checkBtn.disabled = false; }
    }
    return h('div', {}, h('h1', {}, 'Upload data'),
      h('p', { class: 'muted' }, 'Upload the SIS reports as .csv or .xlsx. Nothing is saved until every error is fixed. Re-uploading later updates records (matched on SIS ID and email) and never deletes bookings.'),
      h('div', { class: 'card' }, inputs, h('div', { class: 'row' }, checkBtn, importBtn)), report);
  }

  function uploadReport(r) {
    const box = h('div', { class: 'card' });
    if (r.imported) box.append(banner('ok', h('strong', {}, 'Imported. '), r.summary ? `${r.summary.students} students, ${r.summary.parents} parents/guardians, ${r.summary.teachers} teachers, ${r.summary.sections} sections, ${r.summary.supports} support links.` : ''));
    else if (r.errors.length) box.append(banner('error', h('strong', {}, `${plural(r.errors.length, 'problem')} to fix. `), 'Nothing was imported. Fix the file(s) and check again.'));
    else box.append(banner('ok', h('strong', {}, 'No errors. '), r.summary ? `${r.summary.students} students, ${r.summary.parents} parents/guardians, ${r.summary.teachers} teachers, ${r.summary.sections} sections, ${r.summary.supports} support links. ` : '', 'Click Import to save.'));
    const group = (items, title) => {
      if (!items.length) return null;
      const byFile = new Map();
      for (const e of items) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
      return h('div', {}, h('h2', {}, title), [...byFile].map(([f, list]) => h('div', {}, h('h3', {}, f),
        h('ul', { class: 'report' }, list.map((e) => h('li', {}, e.row ? h('strong', {}, `Row ${e.row}: `) : null, e.message))))));
    };
    add(box, [group(r.errors, 'Errors'), group(r.warnings, 'Warnings (import still allowed)')]);
    return box;
  }

  async function adminEvent() {
    const { event: ev } = await api('GET', '/api/admin/event');
    const days = ev ? ev.days.map((d) => ({ ...d })) : [{ day: '', start_time: '15:00', end_time: '19:00' }];
    const reminders = ev ? [...ev.reminder_times_local] : [];
    const f = {
      name: h('input', { type: 'text', id: 'ev-name', required: true, value: ev ? ev.name : 'Fall Parent-Teacher Conferences' }),
      slot: h('input', { type: 'number', id: 'ev-slot', min: '5', max: '60', value: String(ev ? ev.slot_minutes : 10) }),
      opens: h('input', { type: 'datetime-local', id: 'ev-open', value: ev ? ev.booking_opens_local : '' }),
      closes: h('input', { type: 'datetime-local', id: 'ev-close', value: ev ? ev.booking_closes_local : '' }),
      cutoff: h('input', { type: 'number', id: 'ev-cutoff', min: '0', step: '0.5', value: String(ev ? ev.cutoff_hours : 6) }),
      max: h('input', { type: 'number', id: 'ev-max', min: '1', max: '50', value: String(ev ? ev.max_per_child : 4) }),
      loc: h('textarea', { id: 'ev-loc', placeholder: 'For example: Enter through the main doors on Elm St. Map at school.org/map' }),
    };
    f.loc.value = ev ? ev.location_note : '';
    const dayBox = h('div');
    const remBox = h('div');
    function drawDays() {
      dayBox.replaceChildren(...days.map((d, i) => h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('label', { for: `d-${i}` }, `Day ${i + 1}`), h('input', { type: 'date', id: `d-${i}`, value: d.day, onchange: (e) => { d.day = e.target.value; } })),
        h('div', {}, h('label', { for: `ds-${i}` }, 'Start'), h('input', { type: 'time', id: `ds-${i}`, value: d.start_time, onchange: (e) => { d.start_time = e.target.value; } })),
        h('div', {}, h('label', { for: `de-${i}` }, 'End'), h('input', { type: 'time', id: `de-${i}`, value: d.end_time, onchange: (e) => { d.end_time = e.target.value; } })),
        days.length > 1 ? h('button', { type: 'button', class: 'small-btn danger', 'aria-label': `Remove day ${i + 1}`, onclick: () => { days.splice(i, 1); drawDays(); } }, 'Remove') : null)),
      h('button', { type: 'button', class: 'small-btn', onclick: () => { days.push({ day: '', start_time: '15:00', end_time: '19:00' }); drawDays(); } }, 'Add a day'));
    }
    function drawRem() {
      remBox.replaceChildren(...reminders.map((r, i) => h('div', { class: 'row' },
        h('input', { type: 'datetime-local', class: 'grow', 'aria-label': `Reminder ${i + 1}`, value: r, onchange: (e) => { reminders[i] = e.target.value; } }),
        h('button', { type: 'button', class: 'small-btn danger', onclick: () => { reminders.splice(i, 1); drawRem(); } }, 'Remove'))),
      h('button', { type: 'button', class: 'small-btn', onclick: () => { reminders.push(''); drawRem(); } }, 'Add a reminder time'),
      ev ? null : h('p', { class: 'hint' }, 'Leave empty to use the defaults: 9:00 AM two days before, and 7:00 AM each conference day.'));
    }
    drawDays(); drawRem();
    const msg = h('div');
    const save = h('button', { type: 'submit', class: 'primary' }, ev ? 'Save changes' : 'Create event');
    const field = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
    const form = h('form', {
      async onsubmit(e) {
        e.preventDefault();
        msg.replaceChildren();
        save.disabled = true;
        try {
          const r = await api('POST', '/api/admin/event', {
            name: f.name.value, slot_minutes: Number(f.slot.value), days, booking_opens_at: f.opens.value, booking_closes_at: f.closes.value,
            cutoff_hours: Number(f.cutoff.value), max_per_child: Number(f.max.value), reminder_times: reminders.filter(Boolean), location_note: f.loc.value,
          });
          const st = r.slots;
          toast('Saved');
          msg.append(banner('ok', 'Saved. ', st.added ? `${plural(st.added, 'time slot')} added. ` : '', st.removed ? `${plural(st.removed, 'open slot')} removed. ` : '',
            st.strandedBookings.length ? `${plural(st.strandedBookings.length, 'booking')} now fall outside the event hours; see the dashboard.` : ''));
          await loadMe();
        } catch (ex) {
          msg.append(banner('error', ...(ex.data.errors || [ex.message]).map((x) => h('div', {}, x))));
        } finally { save.disabled = false; }
      },
    },
    h('div', { class: 'card' }, h('h2', {}, 'The event'),
      field('ev-name', 'Event name', f.name),
      h('div', { class: 'field' }, h('label', {}, 'Conference days and hours'), h('div', { class: 'hint' }, `Times are school time (${state.tz}).`), dayBox),
      field('ev-slot', 'Slot length (minutes)', f.slot, 'Conferences run back to back with no buffer.'),
      field('ev-loc', 'Building, entry door or map (shown in reminders)', f.loc)),
    h('div', { class: 'card' }, h('h2', {}, 'Booking rules'),
      field('ev-open', 'Booking opens', f.opens),
      field('ev-close', 'Booking closes', f.closes),
      field('ev-cutoff', 'Parents can change or cancel until this many hours before the event starts', f.cutoff),
      field('ev-max', 'Max conferences per child', f.max, 'You can raise one child\'s limit from their family page.')),
    h('div', { class: 'card' }, h('h2', {}, 'Conference reminder emails'), remBox,
      h('p', { class: 'hint' }, 'Families with bookings get their schedule at each time. On conference days, teachers get their schedule too. Families with nothing booked get a nudge 2 days before booking closes.')),
    msg, save);
    return h('div', {}, h('h1', {}, ev ? 'Event setup' : 'Set up the conference event'), form);
  }

  async function adminFamilies() {
    const q = h('input', { type: 'search', id: 'fq', placeholder: 'Parent name, email, student name or SIS ID', autocomplete: 'off' });
    const results = h('div');
    let timer = null;
    async function search() {
      const { families } = await api('GET', `/api/admin/families?q=${encodeURIComponent(q.value)}`);
      results.replaceChildren(families.length ? h('ul', { class: 'list-plain' }, families.map((f) => h('li', {},
        h('a', { href: `#/admin/family/${f.id}` }, h('strong', {}, f.name)), ` · ${f.email} `,
        f.email_status !== 'ok' ? h('span', { class: 'badge danger' }, f.email_status) : null,
        h('div', { class: 'small muted' }, f.children.map((c) => `${c.first_name} ${c.last_name} (${c.sis_id})`).join(', '))))) : h('p', { class: 'muted' }, 'No matches.'));
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
    await search();
    setTimeout(() => q.focus(), 0);
    return h('div', {}, h('h1', {}, 'Families'), h('p', { class: 'muted' }, 'Find a family to book, move or cancel on their behalf (for families without email or internet), or to raise a child\'s limit.'),
      h('div', { class: 'card' }, h('div', { class: 'field' }, h('label', { for: 'fq' }, 'Search'), q), results));
  }

  async function adminFamily(id) {
    const gid = Number(id);
    const ctx = {
      mode: 'admin',
      slotsUrl: (tid, bid) => `/api/admin/family/${gid}/teachers/${tid}/slots${bid ? `?booking=${bid}` : ''}`,
      cancelUrl: (bid) => `/api/admin/bookings/${bid}/cancel`,
      moveUrl: (bid) => `/api/admin/bookings/${bid}/move`,
      rerender: () => { renderFamily(ctx); $app.prepend(adminTabs('families')); },
      reload: async () => { state.overview = await api('GET', `/api/admin/family/${gid}`); ctx.rerender(); },
    };
    state.picker = null;
    await ctx.reload();
    return undefined;
  }

  async function adminTeachers() {
    const { teachers } = await api('GET', '/api/admin/teachers');
    return h('div', {}, h('h1', {}, 'Teachers'), h('p', { class: 'muted' }, 'Open a teacher to see their schedule, block times, add or move families, or mark them unavailable. You can also change the room used for conferences.'),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'stack-sm' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Teacher'), h('th', {}, 'Email'), h('th', {}, 'Room'), h('th', {}, ''))),
        h('tbody', {}, teachers.map((t) => h('tr', {},
          h('td', { 'data-label': 'Teacher' }, h('a', { href: `#/admin/teacher/${t.id}` }, t.name), t.active ? null : h('span', { class: 'badge warn' }, ' not in latest upload')),
          h('td', { 'data-label': 'Email' }, t.email),
          h('td', { 'data-label': 'Room' }, t.room, t.room_locked ? h('span', { class: 'small muted' }, ' (set here)') : null),
          h('td', {}, h('button', { type: 'button', class: 'small-btn', onclick: () => editRoom(t) }, 'Change room')))))))));
  }

  async function editRoom(t) {
    const input = h('input', { type: 'text', id: 'room', value: t.room, maxlength: '50' });
    const ok = await modal({
      title: `Conference room for ${t.name}`,
      body: [h('div', { class: 'field' }, h('label', { for: 'room' }, 'Room'), input, h('div', { class: 'hint' }, 'Used in emails and schedules. Future uploads won\'t overwrite it.'))],
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', submit: true, class: 'primary' }],
      onSubmit: async () => { await api('POST', `/api/admin/teachers/${t.id}/room`, { room: input.value }); },
    });
    if (ok) { toast('Room saved'); route(); }
  }

  async function adminTeacher(id) {
    const tid = Number(id);
    const data = await api('GET', `/api/admin/teachers/${tid}/schedule`);
    const me = await api('GET', '/api/admin/event');
    const ctx = {
      mode: 'admin', teacher: data.teacher, event: me.event, slots: data.slots, attempts: data.attempts,
      reload: () => adminPage('teacher', id),
      urls: {
        block: (sid, on) => `/api/admin/slots/${sid}/${on ? 'block' : 'unblock'}`,
        cancel: (bid) => `/api/admin/bookings/${bid}/cancel`,
        move: (bid) => `/api/admin/bookings/${bid}/move`,
        add: '/api/admin/bookings',
        roster: `/api/admin/teachers/${tid}/roster`,
        attempt: (aid) => `/api/admin/attempts/${aid}`,
        csv: null,
      },
    };
    renderSchedule(ctx);
    $app.prepend(adminTabs('teachers'));
    return undefined;
  }

  async function adminPrint(by) {
    if (!by) {
      return h('div', {}, h('h1', {}, 'Print & export'),
        h('p', { class: 'muted' }, 'For the front office on conference day. Print to paper, or choose "Save as PDF" in the print window.'),
        h('div', { class: 'card' }, h('ul', { class: 'list-plain' }, ['teacher', 'room', 'family'].map((k) => h('li', { class: 'row between' },
          h('strong', {}, `Master schedule by ${k}`),
          h('div', { class: 'actions' }, h('a', { class: 'btn', href: `#/admin/print/${k}` }, 'Printable page'), h('a', { class: 'btn', href: `/api/admin/export/${k}.csv`, download: '' }, 'CSV')))))));
    }
    const { event: ev, rows } = await api('GET', '/api/admin/master');
    const keyOf = { teacher: (r) => `${r.teacher_name} · Room ${r.room}`, room: (r) => `Room ${r.room}`, family: (r) => `${r.guardian_name} · ${r.guardian_email}` }[by] || ((r) => r.teacher_name);
    const groups = new Map();
    for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const box = h('div', {}, h('p', { class: 'no-print' }, h('a', { href: '#/admin/print' }, '← Print & export'), ' ', h('button', { type: 'button', class: 'primary', onclick: () => window.print() }, 'Print')),
      h('h1', {}, `${ev.name}: by ${by}`), h('p', { class: 'muted' }, `${rows.length} conferences · printed ${fmtDateTime(new Date().toISOString())}`));
    if (!rows.length) box.append(h('p', {}, 'No conferences booked yet.'));
    keys.forEach((k, i) => {
      const list = groups.get(k).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      box.append(h('section', { class: i ? 'card page-break' : 'card' }, h('h2', {}, k),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Time'), by !== 'teacher' ? h('th', {}, 'Teacher') : null, h('th', {}, 'Student(s)'), by !== 'family' ? h('th', {}, 'Parent / guardian') : null, by === 'family' ? h('th', {}, 'Room') : null, h('th', {}, 'Also attending'))),
          h('tbody', {}, list.map((r) => h('tr', {},
            h('td', { class: 'nowrap' }, `${fmtDayShort(r.starts_at)} ${fmtRange(r.starts_at, r.ends_at)}`),
            by !== 'teacher' ? h('td', {}, r.teacher_name) : null,
            h('td', {}, r.students.replace(/; /g, ', ')),
            by !== 'family' ? h('td', {}, r.guardian_name) : null,
            by === 'family' ? h('td', {}, r.room) : null,
            h('td', {}, r.co_teachers.replace(/; /g, ', '))))))));
    });
    return box;
  }

  async function adminEmails() {
    const { emails, transport } = await api('GET', '/api/admin/emails');
    const box = h('div', {}, h('h1', {}, 'Emails'));
    if (transport !== 'smtp') box.append(banner('warn', h('strong', {}, 'Test mode: '), 'emails are saved here but not delivered. Set MAIL_TRANSPORT=smtp to send them (see README).'));
    box.append(h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'stack-sm' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'To'), h('th', {}, 'Subject'), h('th', {}, 'Status'), h('th', {}, ''))),
      h('tbody', {}, emails.map((e) => h('tr', {},
        h('td', { 'data-label': 'When', class: 'nowrap' }, `${fmtDayShort(e.created_at)} ${fmtTime(e.created_at)}`),
        h('td', { 'data-label': 'To' }, e.to_email),
        h('td', { 'data-label': 'Subject' }, e.subject),
        h('td', { 'data-label': 'Status' }, h('span', { class: `badge ${e.status === 'sent' ? 'ok' : e.status === 'queued' || e.status === 'sending' ? '' : 'danger'}` }, e.status), e.last_error ? h('div', { class: 'small muted' }, e.last_error) : null),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'small-btn', onclick: () => showEmail(e.id) }, 'View'),
          h('button', { type: 'button', class: 'small-btn', onclick: async () => { if (await act(() => api('POST', `/api/admin/emails/${e.id}/resend`), 'Queued again')) route(); } }, 'Resend'))))))))));
    if (!emails.length) box.append(h('p', { class: 'muted' }, 'No emails yet.'));
    return box;
  }

  async function showEmail(id) {
    const { email } = await api('GET', `/api/admin/emails/${id}`);
    await modal({ title: email.subject, body: [h('p', { class: 'small muted' }, `To ${email.to_email} · ${email.status}`), h('pre', { class: 'pre' }, email.text_body)], actions: [{ label: 'Close', submit: true }] });
  }

  async function adminAudit() {
    const { entries } = await api('GET', '/api/admin/audit');
    return h('div', {}, h('h1', {}, 'Activity log'), h('p', { class: 'muted' }, 'Every admin and teacher change, every booking and every sign-in (latest 500).'),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', { class: 'hide-sm' }, 'Details'))),
        h('tbody', {}, entries.map((e) => h('tr', {},
          h('td', { class: 'nowrap' }, `${fmtDayShort(e.at)} ${fmtTime(e.at)}`), h('td', {}, e.actor), h('td', {}, e.action),
          h('td', { class: 'small muted hide-sm' }, e.details.length > 160 ? `${e.details.slice(0, 160)}…` : e.details))))))));
  }

  async function adminSettings() {
    const { admins, fromConfig } = await api('GET', '/api/admin/admins');
    const email = h('input', { type: 'email', id: 'new-admin', placeholder: 'name@school.org' });
    const purge = h('input', { type: 'text', id: 'purge', autocomplete: 'off' });
    return h('div', {}, h('h1', {}, 'Settings'),
      h('div', { class: 'card' }, h('h2', {}, 'Admins'),
        h('ul', { class: 'list-plain' }, [...new Set([...fromConfig, ...admins.map((a) => a.email)])].map((e) => h('li', { class: 'row between' }, e,
          fromConfig.includes(e) ? h('span', { class: 'small muted' }, 'set in server settings') : h('button', { type: 'button', class: 'small-btn danger', onclick: async () => { if (await act(() => api('POST', '/api/admin/admins', { email: e, remove: true }), 'Removed')) route(); } }, 'Remove')))),
        h('form', { class: 'row', async onsubmit(ev) { ev.preventDefault(); if (await act(() => api('POST', '/api/admin/admins', { email: email.value }), 'Admin added')) route(); } },
          h('div', { class: 'grow' }, h('label', { for: 'new-admin', class: 'sr-only' }, 'New admin email'), email), h('button', { type: 'submit' }, 'Add admin'))),
      h('div', { class: 'card' }, h('h2', {}, 'Delete family data'),
        h('p', {}, 'After the conferences, delete all student, parent, booking and email records (for example within 30 days). Teachers, rooms, the event setup and the activity log are kept, along with a count of bookings.'),
        h('div', { class: 'field' }, h('label', { for: 'purge' }, 'Type DELETE ALL FAMILY DATA to confirm'), purge),
        h('button', { type: 'button', class: 'danger solid', onclick: async () => { if (await act(() => api('POST', '/api/admin/purge', { confirm: purge.value }), 'Family data deleted')) route(); } }, 'Delete family data')));
  }

  route();
})();
