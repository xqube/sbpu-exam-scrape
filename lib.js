// Pure helpers: no browser, no network. Easy to unit test.

/** "11/13/2026 3:15 PM" (SharePoint, month first) -> "2026-11-13T15:15". Returns null if unparseable. */
export function parseSpDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
  if (!m) return null;
  const [, mo, d, y, hh, mm, ap] = m;
  let h = hh ? Number(hh) : 0;
  if (ap) {
    const pm = ap.toUpperCase() === 'PM';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${mm ?? '00'}`;
}

/**
 * Parse the text of a SharePoint mobile dispform.aspx page.
 * Lines look like "Faculty: Faculty of Science", "Created at <dt> by <user>", ...
 */
export function parseDetailText(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fields = {};
  let created = null;
  let modified = null;
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(/^Created at (.+?) by (.+)$/i))) created = { at: m[1], by: m[2] };
    else if ((m = line.match(/^Last modified at (.+?) by (.+)$/i))) modified = { at: m[1], by: m[2] };
    else if (i > 0 && (m = line.match(/^([^:]{1,40}):\s*(.*)$/))) fields[m[1].trim().toLowerCase()] = m[2].trim();
  });
  return { heading: lines[0] || '', fields, created, modified };
}

/** Strip the "?Mobile=1&Source=..." noise so the URL is the direct file link. */
export function cleanFileUrl(href) {
  try {
    const u = new URL(href);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return href;
  }
}

/** Highest 4-digit year (20xx) found in a library name, or null. */
export function yearOf(name) {
  const ys = [...name.matchAll(/(20\d{2})/g)].map((m) => Number(m[1]));
  return ys.length ? Math.max(...ys) : null;
}

export const sortKey = (it) => it.modifiedIso || it.dateIso || '';
export const byLatest = (a, b) => sortKey(b).localeCompare(sortKey(a));

const TRACKED = ['folder', 'title', 'fileName', 'fileUrl', 'faculty', 'course', 'date', 'modifiedAt'];

/**
 * Compare previous state with this run.
 * scopedLibraries: libraries that were crawled this run (only those can have removals)
 * listedKeys: every item key that appeared in the list pages this run
 */
export function diffItems(oldItems, newItems, { scopedLibraries, listedKeys }) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [k, n] of Object.entries(newItems)) {
    const o = oldItems[k];
    if (!o) {
      added.push(n);
      continue;
    }
    const fields = TRACKED.filter((f) => (o[f] ?? '') !== (n[f] ?? ''));
    if (fields.length) {
      changed.push({ item: n, fields, before: Object.fromEntries(fields.map((f) => [f, o[f] ?? ''])) });
    }
  }
  for (const [k, o] of Object.entries(oldItems)) {
    if (scopedLibraries.has(o.library) && !listedKeys.has(k)) removed.push(o);
  }
  return { added: added.sort(byLatest), changed, removed };
}

/** { faculty: { course: [items newest-first] } } with alphabetical keys. */
export function groupByFacultyCourse(items) {
  const tmp = {};
  for (const it of [...items].sort(byLatest)) {
    const f = it.faculty || '(no faculty)';
    const c = it.course || '(no course)';
    ((tmp[f] ??= {})[c] ??= []).push(it);
  }
  const out = {};
  for (const f of Object.keys(tmp).sort()) {
    out[f] = {};
    for (const c of Object.keys(tmp[f]).sort()) out[f][c] = tmp[f][c];
  }
  return out;
}

const CSV_COLS = [
  'faculty', 'course', 'title', 'library', 'folder', 'date', 'modifiedAt', 'modifiedBy',
  'createdAt', 'fileName', 'fileUrl', 'detailUrl',
];

export function toCsv(items) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...items.map((it) => CSV_COLS.map((c) => esc(it[c])).join(','))].join('\n');
}