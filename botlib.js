// Pure helpers for bot.js (Telegram HTML formatting, filtering, chunking). No network, no grammy.
import { EXAM_LABELS, upcomingDeadlines, hoursUntil } from './examlib.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');
export const link = (url, text) => (url ? `<a href="${attr(url)}">${esc(text)}</a>` : esc(text));

export const TG_LIMIT = 4096;

/** Pack blocks into messages under the Telegram limit without splitting a block (keeps HTML tags intact). */
export function chunkBlocks(blocks, max = 3800, sep = '\n\n') {
  const out = [];
  let cur = '';
  for (let b of blocks.filter(Boolean)) {
    if (b.length > max) b = b.replace(/<[^>]+>/g, '').slice(0, max - 1) + '…'; // pathological block: drop markup
    if (cur && cur.length + sep.length + b.length > max) {
      out.push(cur);
      cur = b;
    } else cur = cur ? cur + sep + b : b;
  }
  if (cur) out.push(cur);
  return out;
}

/** Normalise "B.Sc, Computer Science ,,b.sc" -> ['b.sc', 'computer science'] */
export function parseKeywords(s, max = 20) {
  return [...new Set(String(s || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, max);
}

/** No keywords = wants everything. Otherwise any keyword must appear in any of the fields. */
export function matchesWatch(keywords, ...fields) {
  if (!keywords || !keywords.length) return true;
  const hay = fields.join(' \n ').toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

const circText = (it) => [it.faculty, it.course, it.title, it.library, it.fileName];

/** All whitespace-separated words must appear somewhere in the item. */
export function searchItems(items, query, textOf = circText, limit = 10) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const it of items) {
    const hay = textOf(it).join(' ').toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
export const searchCirculars = (items, q, limit) => searchItems(items, q, circText, limit);
export const searchExams = (items, q, limit) => searchItems(items, q, (it) => [it.course, it.status], limit);

export function formatCircular(it) {
  const where = [it.faculty, it.course].filter(Boolean).join(' › ');
  const meta = [it.library, it.modifiedAt || it.date].filter(Boolean).join(' · ');
  const links = [it.fileUrl && link(it.fileUrl, 'Open file'), it.detailUrl && link(it.detailUrl, 'Details')]
    .filter(Boolean).join(' · ');
  return [`📄 <b>${esc(it.title || it.fileName || '(untitled)')}</b>`, where && esc(where), meta && `<i>${esc(meta)}</i>`, links]
    .filter(Boolean).join('\n');
}

export function formatExam(it, nowIso) {
  const lines = [`🎓 <b>${esc(it.course)}</b> — ${esc(it.status || '?')}${it.active ? ' ✅' : ''}`];
  for (const f of ['startDate', 'endNoLate', 'endLate', 'fineEnd', 'paymentEnd']) {
    if (it[f]) lines.push(`${EXAM_LABELS[f]}: ${esc(it[f])}`);
  }
  if (nowIso && it.active) {
    const next = upcomingDeadlines([it], nowIso)[0]?.next;
    if (next) lines.push(`⏳ <b>Next:</b> ${esc(next.label)} — ${esc(next.raw)}`);
  }
  return lines.join('\n');
}

const SHOW_MAX = 30;
const capped = (blocks, total, hint) =>
  total > blocks.length ? [...blocks, `…and ${total - blocks.length} more. ${hint}`] : blocks;

/** Telegram blocks for a circulars diff, filtered by one subscriber's keywords. [] when nothing relevant. */
export function circularChangeBlocks(diff, keywords) {
  const keep = (it) => matchesWatch(keywords, ...circText(it));
  const added = diff.added.filter(keep);
  const changed = diff.changed.filter((c) => keep(c.item));
  const removed = diff.removed.filter(keep);
  const out = [];
  if (added.length) {
    out.push(`🆕 <b>New circulars / timetables (${added.length})</b>`);
    out.push(...capped(added.slice(0, SHOW_MAX).map(formatCircular), added.length, 'Use /latest or /search.'));
  }
  if (changed.length) {
    out.push(`✏️ <b>Updated (${changed.length})</b>`);
    out.push(...capped(changed.slice(0, SHOW_MAX).map((c) => {
      const fileTouched = c.fields.some((f) => ['modifiedAt', 'fileUrl', 'fileName'].includes(f));
      const edits = c.fields
        .filter((f) => ['title', 'faculty', 'course', 'date'].includes(f))
        .map((f) => `${f}: ${esc(c.before[f] || '-')} → ${esc(c.item[f] || '-')}`);
      if (fileTouched) edits.push('file re-uploaded');
      return `${formatCircular(c.item)}${edits.length ? `\n<i>${edits.join('; ')}</i>` : ''}`;
    }), changed.length, 'Use /latest or /search.'));
  }
  if (removed.length) {
    out.push(`🗑 <b>Removed (${removed.length})</b>`);
    out.push(...capped(removed.slice(0, SHOW_MAX).map((i) => `• ${esc(i.title || i.fileName)} <i>(${esc(i.library)})</i>`), removed.length, ''));
  }
  return out;
}

/** Telegram blocks for an exam-dates diff. `closed` (deadline simply passed) only when includeClosed. */
export function examChangeBlocks(diff, keywords, { includeClosed = false } = {}) {
  const keep = (it) => matchesWatch(keywords, it.course);
  const out = [];
  const added = diff.added.filter(keep);
  if (added.length) {
    out.push(`🆕 <b>Exam form window opened (${added.length})</b>`);
    out.push(...capped(added.slice(0, SHOW_MAX).map((i) => formatExam(i)), added.length, 'Use /exams.'));
  }
  const reopened = diff.reopened.filter(keep);
  if (reopened.length) {
    out.push(`🔓 <b>Exam form window reopened (${reopened.length})</b>`);
    out.push(...reopened.slice(0, SHOW_MAX).map((i) => formatExam(i)));
  }
  const changed = diff.changed.filter((c) => keep(c.item));
  if (changed.length) {
    out.push(`📅 <b>Exam form dates changed (${changed.length})</b>`);
    out.push(...capped(changed.slice(0, SHOW_MAX).map((c) =>
      [`🎓 <b>${esc(c.item.course)}</b>`,
        ...c.fields.map((f) => `${EXAM_LABELS[f] || f}: ${esc(c.before[f] || '-')} → <b>${esc(c.item[f] || '-')}</b>`)].join('\n')),
    changed.length, 'Use /exams.'));
  }
  const removed = diff.removed.filter(keep);
  if (removed.length) {
    out.push(`🗑 <b>Exam window removed (${removed.length})</b>`);
    out.push(removed.slice(0, SHOW_MAX).map((i) => `• ${esc(i.course)}`).join('\n'));
  }
  const closed = includeClosed ? diff.closed.filter(keep) : [];
  if (closed.length) {
    out.push(`🔒 <b>Exam form window closed (${closed.length})</b>`);
    out.push(closed.slice(0, SHOW_MAX).map((i) => `• ${esc(i.course)}`).join('\n'));
  }
  return out;
}

export function reminderBlock(item, next, nowIso) {
  const h = Math.max(0, hoursUntil(next.iso, nowIso));
  const left = h >= 24 ? `${Math.round(h / 24)} day(s)` : h >= 1 ? `${Math.round(h)} hour(s)` : 'under an hour';
  return `⏰ <b>Deadline in ${left}</b>\n🎓 ${esc(item.course)}\n${esc(next.label)}: <b>${esc(next.raw)}</b>`;
}
