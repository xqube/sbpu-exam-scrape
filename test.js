import assert from 'node:assert/strict';
import { parseSpDate, parseDetailText, cleanFileUrl, yearOf, diffItems, groupByFacultyCourse, toCsv } from './lib.js';

// Real text structure from a dispform.aspx page
const sample = `Time Tables OCT/NOV 2026: S.Y. M.A(Journalism-and-Mass-Communication)(Patt.-2024)_Spl (2)-2

Name: S.Y. M.A(Journalism-and-Mass-Communication)(Patt.-2024)_Spl (2)-2.pdf
Title: S.Y. M.A(Journalism-&-Mass-Communication)(Patt.-2024)_Spl (2)-2
Faculty: Faculty of Inter-Disciplinary
Course: C) OTHER
Date: 11/13/2026

Created at 11/13/2026 3:15 PM by uop-webmaster
Last modified at 11/13/2026 3:15 PM by uop-webmaster`;

const d = parseDetailText(sample);
assert.equal(d.fields.faculty, 'Faculty of Inter-Disciplinary');
assert.equal(d.fields.course, 'C) OTHER');
assert.equal(d.fields.date, '11/13/2026');
assert.equal(d.modified.by, 'uop-webmaster');
assert.ok(!('time tables oct/nov 2026' in d.fields), 'heading must not become a field');
assert.equal(parseSpDate('11/13/2026 3:15 PM'), '2026-11-13T15:15');
assert.equal(parseSpDate('9/3/2026 12:05 AM'), '2026-09-03T00:05');
assert.equal(parseSpDate('10/7/2026'), '2026-10-07T00:00');
assert.equal(yearOf('Time Tables OCT/NOV 2026'), 2026);
assert.equal(yearOf('APRIL2019'), 2019);
assert.equal(yearOf('Results'), null);
assert.equal(
  cleanFileUrl('http://x/sites/examdocs/Lib/a%20b.pdf?Mobile=1&Source=%2Fsites'),
  'http://x/sites/examdocs/Lib/a%20b.pdf');

const mk = (id, o = {}) => ({ key: `L#${id}`, library: 'L', id, title: `t${id}`, fileName: '', fileUrl: '',
  faculty: 'Sci', course: 'UG', date: '', modifiedAt: 'm1', modifiedIso: `2026-11-0${id}T10:00`, ...o });
const old = { 'L#1': mk(1), 'L#2': mk(2), 'L#3': mk(3) };
const now = { 'L#1': mk(1), 'L#2': mk(2, { modifiedAt: 'm2' }), 'L#4': mk(4) };
const diff = diffItems(old, now, { scopedLibraries: new Set(['L']), listedKeys: new Set(['L#1', 'L#2', 'L#4']) });
assert.deepEqual(diff.added.map((i) => i.id), [4]);
assert.deepEqual(diff.changed.map((c) => c.fields), [['modifiedAt']]);
assert.deepEqual(diff.removed.map((i) => i.id), [3]);
// out-of-scope libraries are never reported as removed
assert.equal(diffItems(old, {}, { scopedLibraries: new Set(['other']), listedKeys: new Set() }).removed.length, 0);

const g = groupByFacultyCourse(Object.values(now));
assert.deepEqual(Object.keys(g), ['Sci']);
assert.equal(g.Sci.UG[0].id, 4); // newest first
assert.ok(toCsv(Object.values(now)).split('\n').length === 4);


// ---------------------------------------------------------------------------
// examlib (exam form dates site)
// ---------------------------------------------------------------------------
import {
  parseExDate, rowsToItems, diffExamDates, upcomingDeadlines, byStartDesc,
  toExamCsv, formatExamReport, hoursUntil,
} from './examlib.js';
import {
  esc, chunkBlocks, parseKeywords, matchesWatch, searchCirculars, searchExams,
  circularChangeBlocks, examChangeBlocks, formatExam,
} from './botlib.js';

assert.equal(parseExDate('13 NOV 2026 16:59'), '2026-11-13T16:59');
assert.equal(parseExDate('04 Nov 2026'), '2026-11-04T00:00');
assert.equal(parseExDate('4 November 2026 9:05'), '2026-11-04T09:05');
assert.equal(parseExDate('-'), null);
assert.equal(parseExDate(''), null);

const header = ['SR NO', 'COURSE', 'STATUS', 'START DATE', 'WITHOUT LATE FEE END DATE', 'WITH LATE FEE END DATE',
  'FINE FEE END DATE', 'EXAM FORM PAYMENT LINK END DATE'];
const rows = [
  ['1', 'B.Sc (2024 Pattern)', 'Active', '04 Nov 2026', '13 NOV 2026 16:59', '16 NOV 2026 16:59', '18 NOV 2026 16:59', '19 NOV 2026 23:59'],
  ['2', 'M.A. (2019 Pattern)', 'Closed', '01 Oct 2026', '10 OCT 2026 16:59', '', '', ''],
  ['3', 'B.Sc (2024 Pattern)', 'Active', '05 Nov 2026', '14 NOV 2026 16:59', '', '', ''],
  ['4', '', 'Active', '', '', '', '', ''],
];
const ex = rowsToItems(header, rows);
assert.deepEqual(Object.keys(ex), ['B.Sc (2024 Pattern)', 'M.A. (2019 Pattern)', 'B.Sc (2024 Pattern)#2']);
assert.equal(ex['B.Sc (2024 Pattern)'].active, true);
assert.equal(ex['M.A. (2019 Pattern)'].active, false);
assert.equal(ex['B.Sc (2024 Pattern)'].endLateIso, '2026-11-16T16:59');
assert.throws(() => rowsToItems(['A', 'B'], []), /COURSE column/);

// diff: edited dates vs plain closing vs reopening vs add/remove
const ex2 = structuredClone(ex);
ex2['B.Sc (2024 Pattern)'].endNoLate = '15 NOV 2026 16:59';          // date edit -> changed
ex2['B.Sc (2024 Pattern)#2'].status = 'Closed';                    // only status -> closed
ex2['B.Sc (2024 Pattern)#2'].active = false;
ex2['M.A. (2019 Pattern)'].status = 'Active';                      // only status -> reopened
ex2['M.A. (2019 Pattern)'].active = true;
ex2['New Course'] = { key: 'New Course', course: 'New Course', status: 'Active', active: true };
const ed = diffExamDates(ex, ex2);
assert.deepEqual(ed.added.map((i) => i.course), ['New Course']);
assert.deepEqual(ed.changed.map((c) => c.fields), [['endNoLate']]);
assert.deepEqual(ed.closed.map((i) => i.key), ['B.Sc (2024 Pattern)#2']);
assert.deepEqual(ed.reopened.map((i) => i.key), ['M.A. (2019 Pattern)']);
assert.equal(diffExamDates(ex, {}).removed.length, 3);
assert.equal(diffExamDates(ex, ex).added.length + diffExamDates(ex, ex).changed.length, 0);
const rep = formatExamReport(ed);
assert.ok(rep.includes('NEW EXAM WINDOWS') && rep.includes('13 NOV 2026 16:59 -> 15 NOV 2026 16:59') && rep.includes('CLOSED'));

// deadlines: only Active, next one per window, soonest first, optional horizon
const list = Object.values(ex);
const up = upcomingDeadlines(list, '2026-11-14T10:00');
assert.deepEqual(up.map((u) => u.item.key), ['B.Sc (2024 Pattern)#2', 'B.Sc (2024 Pattern)']); // 14th 16:59 then 16th
assert.equal(up[1].next.label, 'With late fee');   // 13th already passed
assert.equal(upcomingDeadlines(list, '2026-11-14T10:00', 1).length, 1); // only the one due within 24h
assert.equal(upcomingDeadlines(list, '2026-12-01T00:00').length, 0);
assert.ok(!up.some((u) => u.item.key.startsWith('M.A.'))); // closed window never listed
assert.equal(hoursUntil('2026-11-14T16:00', '2026-11-14T10:00'), 6);
assert.deepEqual(list.sort(byStartDesc).map((i) => i.startIso.slice(0, 10)), ['2026-11-05', '2026-11-04', '2026-10-01']);

const ecsv = toExamCsv(list).split('\n');
assert.equal(ecsv.length, 4);
assert.equal(ecsv[0], 'course,status,startDate,endNoLate,endLate,fineEnd,paymentEnd');
assert.ok(toExamCsv([{ course: 'A, "B"' }]).includes('"A, ""B"""'));

// ---------------------------------------------------------------------------
// botlib
// ---------------------------------------------------------------------------
assert.equal(esc('a<b>&"'), 'a&lt;b&gt;&amp;"');
assert.deepEqual(parseKeywords(' B.Sc, law ,,b.sc'), ['b.sc', 'law']);
assert.ok(matchesWatch([], 'anything'));
assert.ok(matchesWatch(['law'], 'Faculty of Law', 'x'));
assert.ok(!matchesWatch(['law'], 'Faculty of Science'));

const chunks = chunkBlocks(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], 70);
assert.equal(chunks.length, 2);
assert.ok(chunks.every((c) => c.length <= 70));
assert.ok(chunkBlocks(['<b>' + 'x'.repeat(100) + '</b>'], 50)[0].length <= 50); // oversize block loses markup, never a broken tag
assert.deepEqual(chunkBlocks([]), []);

const circ = Object.values(now);
assert.equal(searchCirculars(circ, 'sci ug').length, circ.length);
assert.equal(searchCirculars(circ, 'nomatch').length, 0);
assert.equal(searchExams(list, 'm.a.').length, 1);

const cb = circularChangeBlocks(diff, []);
assert.ok(cb[0].includes('New circulars') && cb.some((b) => b.includes('Updated')) && cb.some((b) => b.includes('Removed')));
assert.deepEqual(circularChangeBlocks(diff, ['zzz']), []); // watch filter hides everything
const eb = examChangeBlocks(ed, []);
assert.ok(eb.some((b) => b.includes('opened')) && eb.some((b) => b.includes('reopened')) && eb.some((b) => b.includes('changed')));
assert.ok(!eb.some((b) => b.includes('closed')));                                  // quiet by default
assert.ok(examChangeBlocks(ed, [], { includeClosed: true }).some((b) => b.includes('closed')));
assert.deepEqual(examChangeBlocks(ed, ['nothing-like-this']), []);
assert.ok(formatExam(ex['B.Sc (2024 Pattern)'], '2026-11-14T10:00').includes('Next:'));

console.log('all tests passed');
