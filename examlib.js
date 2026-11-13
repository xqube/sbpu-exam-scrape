// Pure helpers for https://examform.unipune.ac.in/Support/StuExDates.aspx (no browser, no network).

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "13 NOV 2026 16:59" or "04 Nov 2026" -> "2026-11-13T16:59" (site-local time, no timezone). */
export function parseExDate(s) {
  const m = (s || '').match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(mo)}-${p(m[1])}T${p(m[4] ?? 0)}:${m[5] ?? '00'}`;
}

const COLS = {
  course: /^course$/i,
  status: /^status$/i,
  startDate: /^start date$/i,
  endNoLate: /^without late fee end date$/i,
  endLate: /^with late fee end date$/i,
  fineEnd: /^fine fee end date$/i,
  paymentEnd: /^exam form payment link end date$/i,
};

/** Header cells + data rows (arrays of cell text) -> { key: item }. Columns are matched by header name. */
export function rowsToItems(headerCells, rows) {
  const idx = {};
  headerCells.forEach((h, i) => {
    const norm = h.trim().replace(/\s+/g, ' ');
    for (const [k, re] of Object.entries(COLS)) if (re.test(norm)) idx[k] = i;
  });
  if (idx.course === undefined) throw new Error('COURSE column not found; page layout changed?');

  const items = {};
  const seen = new Map();
  for (const r of rows) {
    const g = (k) => (idx[k] === undefined ? '' : (r[idx[k]] || '').trim());
    const course = g('course');
    if (!course) continue;
    const n = (seen.get(course) || 0) + 1;
    seen.set(course, n);
    const key = n === 1 ? course : `${course}#${n}`; // same course name listed twice -> stable-ish suffix
    const it = {
      key, course, status: g('status'),
      startDate: g('startDate'), endNoLate: g('endNoLate'), endLate: g('endLate'),
      fineEnd: g('fineEnd'), paymentEnd: g('paymentEnd'),
    };
    it.active = /^active$/i.test(it.status);
    it.startIso = parseExDate(it.startDate);
    it.endNoLateIso = parseExDate(it.endNoLate);
    it.endLateIso = parseExDate(it.endLate);
    it.fineEndIso = parseExDate(it.fineEnd);
    it.paymentEndIso = parseExDate(it.paymentEnd);
    items[key] = it;
  }
  return items;
}

export const EXAM_FIELDS = ['status', 'startDate', 'endNoLate', 'endLate', 'fineEnd', 'paymentEnd'];

/**
 * added / changed (dates edited) / closed (Active -> over, nothing else changed) /
 * reopened / removed. "closed" is kept apart because it happens by itself when a deadline passes.
 */
export function diffExamDates(oldItems, newItems) {
  const added = [], changed = [], closed = [], reopened = [], removed = [];
  for (const [k, n] of Object.entries(newItems)) {
    const o = oldItems[k];
    if (!o) { added.push(n); continue; }
    const fields = EXAM_FIELDS.filter((f) => (o[f] ?? '') !== (n[f] ?? ''));
    if (!fields.length) continue;
    if (fields.length === 1 && fields[0] === 'status') (n.active ? reopened : closed).push(n);
    else changed.push({ item: n, fields, before: Object.fromEntries(fields.map((f) => [f, o[f] ?? ''])) });
  }
  for (const [k, o] of Object.entries(oldItems)) if (!(k in newItems)) removed.push(o);
  return { added, changed, closed, reopened, removed };
}

export const byStartDesc = (a, b) =>
  (b.startIso || '').localeCompare(a.startIso || '') || a.course.localeCompare(b.course);

/** Current time in the site's timezone as "YYYY-MM-DDTHH:mm" (default IST = +330 min). */
export function nowIst(offsetMin = Number(process.env.SITE_TZ_OFFSET_MIN ?? 330)) {
  return new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 16);
}

const addDays = (iso, days) => new Date(`${iso}:00Z`).getTime() + days * 86_400_000;
const DEADLINES = [
  ['endNoLateIso', 'endNoLate', 'Without late fee'],
  ['endLateIso', 'endLate', 'With late fee'],
  ['fineEndIso', 'fineEnd', 'Fine fee'],
  ['paymentEndIso', 'paymentEnd', 'Payment link'],
];

/** Active windows with a deadline still ahead (optionally within N days), soonest first. */
export function upcomingDeadlines(items, nowIso, days = Infinity) {
  const limit = days === Infinity ? Infinity : addDays(nowIso, days);
  const out = [];
  for (const it of items) {
    if (!it.active) continue;
    const next = DEADLINES
      .filter(([iso]) => it[iso] && it[iso] >= nowIso && (limit === Infinity || new Date(`${it[iso]}:00Z`).getTime() <= limit))
      .map(([iso, raw, label]) => ({ iso: it[iso], raw: it[raw], label }))
      .sort((a, b) => a.iso.localeCompare(b.iso))[0];
    if (next) out.push({ item: it, next });
  }
  return out.sort((a, b) => a.next.iso.localeCompare(b.next.iso) || a.item.course.localeCompare(b.item.course));
}

export const EXAM_CSV_COLS = [
  'course', 'status', 'startDate', 'endNoLate', 'endLate', 'fineEnd', 'paymentEnd',
];
export const EXAM_LABELS = {
  status: 'Status',
  startDate: 'Start date',
  endNoLate: 'Without late fee end',
  endLate: 'With late fee end',
  fineEnd: 'Fine fee end',
  paymentEnd: 'Payment link end',
};

const csvEsc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toExamCsv(items) {
  return [EXAM_CSV_COLS.join(','), ...items.map((it) => EXAM_CSV_COLS.map((c) => csvEsc(it[c])).join(','))].join('\n');
}

/** Plain-text report of an exam-dates diff (console / webhook). `closed` is listed last and is quiet by nature. */
export function formatExamReport(diff) {
  const line = (it) =>
    `${it.course} | ${it.status || '?'} | start ${it.startDate || '-'} | ` +
    `no late fee ${it.endNoLate || '-'} | late fee ${it.endLate || '-'}`;
  const out = [];
  if (diff.added.length) out.push(`NEW EXAM WINDOWS (${diff.added.length})`, ...diff.added.map((i) => `  + ${line(i)}`));
  if (diff.reopened.length) out.push(`REOPENED (${diff.reopened.length})`, ...diff.reopened.map((i) => `  ^ ${line(i)}`));
  if (diff.changed.length) {
    out.push(`DATES CHANGED (${diff.changed.length})`);
    for (const c of diff.changed) {
      out.push(`  ~ ${c.item.course}`);
      for (const f of c.fields) out.push(`      ${EXAM_LABELS[f] || f}: ${c.before[f] || '-'} -> ${c.item[f] || '-'}`);
    }
  }
  if (diff.removed.length) out.push(`REMOVED (${diff.removed.length})`, ...diff.removed.map((i) => `  - ${line(i)}`));
  if (diff.closed.length) out.push(`CLOSED (${diff.closed.length})`, ...diff.closed.map((i) => `  x ${i.course}`));
  return out.join('\n');
}

/** Hours from `nowIso` until `iso` (both "YYYY-MM-DDTHH:mm" site-local). Negative if past. */
export function hoursUntil(iso, nowIso) {
  return (new Date(`${iso}:00Z`).getTime() - new Date(`${nowIso}:00Z`).getTime()) / 3_600_000;
}
