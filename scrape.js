#!/usr/bin/env node
/**
 * Savitribai Phule Pune University - Examination Circulars watcher.
 *
 * Stage 1 (runs first, separate site): exam form dates table at examform.unipune.ac.in -> data/exam/*
 * Stage 2 (circulars): root (all libraries) -> each library's item list -> each item's detail page.
 * Output: data/exam/{state,latest}.json, data/exam/latest.csv, data/exam/changes/<timestamp>.json,
 *         data/state.json, data/latest.json, data/by_faculty.json, data/latest.csv,
 *         data/changes/<timestamp>.json (only when something changed)
 * Run it on a schedule (cron / GitHub Actions); it prints and optionally webhooks the diff.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseSpDate, parseDetailText, cleanFileUrl, yearOf,
  byLatest, diffItems, groupByFacultyCourse, toCsv,
} from './lib.js';
import {
  rowsToItems, diffExamDates, byStartDesc, upcomingDeadlines, nowIst, toExamCsv, formatExamReport,
} from './examlib.js';

const ROOT = 'http://collegecirculars.unipune.ac.in/sites/examdocs/_layouts/mobile/mbllists.aspx';

const HELP = `Usage: node scrape.js [options]

  (default)            Crawl ALL document libraries except obvious junk (test, test2, test3,
                       Site Assets, Site Pages, Style Library). First run is slow; see --since for daily runs.
  --list-libs          Only discover libraries, print them (and what would be skipped), then exit
  --since <year>       Narrow: only libraries whose name has a year >= this (libraries with no
                       year in the name are kept, since e.g. "Results" has none)
  --all                Really everything, including the junk libraries
  --match <regex>      Narrow: only libraries whose name matches (case-insensitive), e.g. "OCT/NOV 2026"
  --fast               Don't re-open detail pages of items already in state (new items only)
  --concurrency <n>    Parallel pages (default 4)
  --delay <ms>         Pause after each page load, per worker (default 300)
  --out <dir>          Output directory (default ./data)
  --no-exam            Skip the exam form dates stage (examform.unipune.ac.in)
  --exam-only          Only run the exam form dates stage, then exit
  --headed             Show the browser
  --fail-on-change     Exit with code 10 if anything new/changed/removed (handy for CI)
Env: NOTIFY_WEBHOOK  POST {text, content} here when changes are found (Slack/Discord compatible)
`;

function parseArgs(argv) {
  const o = {
    all: false, since: null, match: null, fast: false, listLibs: false,
    concurrency: 4, delay: 300, out: 'data', headed: false, failOnChange: false,
    noExam: false, examOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--all': o.all = true; break;
      case '--since': o.since = Number(next()); break;
      case '--match': o.match = new RegExp(next(), 'i'); break;
      case '--fast': o.fast = true; break;
      case '--list-libs': o.listLibs = true; break;
      case '--concurrency': o.concurrency = Math.max(1, Number(next())); break;
      case '--delay': o.delay = Number(next()); break;
      case '--out': o.out = next(); break;
      case '--no-exam': o.noExam = true; break;
      case '--exam-only': o.examOnly = true; break;
      case '--headed': o.headed = true; break;
      case '--fail-on-change': o.failOnChange = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0);
      default: console.error(`Unknown option: ${a}\n${HELP}`); process.exit(2);
    }
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function goto(page, url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(1000 * i);
    }
  }
}

const anchorsOf = (page) =>
  page.$$eval('a[href]', (as) => as.map((a, idx) => ({ idx, text: a.textContent.trim(), href: a.href })));

const LIBS_URL = 'http://collegecirculars.unipune.ac.in/sites/examdocs/_layouts/viewlsts.aspx?BaseType=1';

/** Identity of a library = its folder path, lowercased (ignores view name and query string). */
const libKey = (href) => decodeURIComponent(new URL(href).pathname).toLowerCase().split('/forms/')[0];
const toMobile = (href) => {
  const u = new URL(href);
  u.searchParams.set('Mobile', '1');
  return u.toString();
};
const isNextLink = (a) =>
  /^(next|more|show more|view more|›|»|>>|\.\.\.)/i.test(a.text) ||
  /[?&](Paged=TRUE|PageFirstRow=|Page=\d)/i.test(a.href);

/** Collect library links from one starting page, following next/more links. */
async function collectLibs(page, startUrl, label, debugDir) {
  const found = new Map();
  const seenPages = new Set();
  let url = startUrl;
  for (let p = 0; url && p < 30 && !seenPages.has(url); p++) {
    seenPages.add(url);
    await goto(page, url);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(debugDir, `${label}-${p}.html`), await page.content());
    const anchors = await anchorsOf(page);
    for (const a of anchors) {
      if (!/\/Forms\//i.test(a.href) || !a.text) continue;
      const k = libKey(a.href);
      if (!found.has(k)) found.set(k, { name: a.text, url: toMobile(a.href) });
    }
    url = anchors.find(isNextLink)?.href;
  }
  return found;
}

/** Step 1: every document library. Merges several sources because the mobile page can be truncated. */
async function discoverLibraries(makeContext, outDir) {
  const debugDir = path.join(outDir, 'debug');
  await fs.mkdir(debugDir, { recursive: true });
  const strategies = [
    ['desktop-root', {}, ROOT],
    ['mobile-root', devices['iPhone 13'], ROOT],
    ['all-site-content', {}, LIBS_URL],
  ];
  const merged = new Map();
  for (const [label, ctxOpts, url] of strategies) {
    const ctx = await makeContext(ctxOpts);
    try {
      const page = await ctx.newPage();
      const found = await collectLibs(page, url, label, debugDir);
      let fresh = 0;
      for (const [k, v] of found) if (!merged.has(k)) { merged.set(k, v); fresh++; }
      log(`discovery ${label}: ${found.size} libraries (${fresh} new)`);
    } catch (e) {
      log(`discovery ${label} failed: ${e.message}`);
    } finally {
      await ctx.close();
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Folder key relative to the library root ('root' for the top level). */
const folderKey = (href, libPath) => {
  const rf = (new URL(href).searchParams.get('RootFolder') || '').toLowerCase().replace(/\/$/, '');
  return rf && rf !== libPath ? rf : 'root';
};
const isHttp = (h) => /^https?:/i.test(h);

/**
 * Step 2: all item detail links in a library.
 * Recurses into sub-folders (RootFolder=... links) and follows paging, including
 * ASP.NET postback paging (javascript:__doPostBack), which has to be clicked, not navigated to.
 */
async function listItems(page, lib, delay, outDir) {
  const items = new Map(); // id -> { url, folder }
  const libPath = libKey(lib.url);
  const queue = [lib.url];
  const visited = new Set();
  let pagesSeen = 0;
  let dumped = false;

  while (queue.length && pagesSeen < 500) {
    const start = queue.shift();
    const fk = folderKey(start, libPath);
    if (visited.has(fk)) continue;
    visited.add(fk);
    const folder = fk === 'root' ? '' : fk.slice(libPath.length).replace(/^\//, '');
    await goto(page, start);

    for (let pg = 0; pg < 100; pg++) {
      pagesSeen++;
      const anchors = await anchorsOf(page);
      let added = 0;
      for (const a of anchors) {
        if (!isHttp(a.href)) continue;
        if (/dispform\.aspx/i.test(a.href)) {
          const id = new URL(a.href).searchParams.get('ID');
          if (id && !items.has(id)) { items.set(id, { url: a.href, folder }); added++; }
        } else if (/[?&]RootFolder=/i.test(a.href) && !visited.has(folderKey(a.href, libPath))) {
          queue.push(a.href);
        }
      }
      if (!items.size && !dumped && !queue.length) {
        dumped = true;
        const f = path.join(outDir, 'debug', `empty-${lib.name.replace(/[^\w.-]+/g, '_')}.html`);
        await fs.writeFile(f, await page.content());
        log(`  (no items or folders found; saved ${f})`);
      }
      const next = anchors.find(isNextLink);
      if (!next || (pg > 0 && !added)) break;
      if (isHttp(next.href)) {
        if (next.href === page.url()) break;
        await goto(page, next.href);
      } else {
        // javascript:__doPostBack(...) -> click it and wait for the reload
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45_000 }),
          page.locator('a[href]').nth(next.idx).click(),
        ]);
      }
      await sleep(delay);
    }
  }
  return items;
}

/** Step 3: one item's detail page -> normalized record. */
async function scrapeItem(page, lib, id, detailUrl, folder = '') {
  await goto(page, detailUrl);
  const text = await page.evaluate(() => document.body.innerText);
  const anchors = await anchorsOf(page);
  const d = parseDetailText(text);
  const nameText = d.fields.name;
  const file =
    anchors.find((a) => nameText && a.text === nameText && !/_layouts/i.test(a.href)) ||
    anchors.find((a) => a.text && !/_layouts/i.test(a.href) && !/\/sites\/examdocs\/?(\?|$)/i.test(a.href));
  return {
    key: `${lib.name}#${id}`,
    library: lib.name,
    id,
    folder,
    detailUrl,
    title: d.fields.title || d.heading.replace(/^.*?:\s*/, ''),
    fileName: nameText || file?.text || '',
    fileUrl: file ? cleanFileUrl(file.href) : '',
    faculty: d.fields.faculty || '',
    course: d.fields.course || '',
    date: d.fields.date || '',
    dateIso: parseSpDate(d.fields.date),
    createdAt: d.created?.at || '',
    createdBy: d.created?.by || '',
    modifiedAt: d.modified?.at || '',
    modifiedBy: d.modified?.by || '',
    modifiedIso: parseSpDate(d.modified?.at),
  };
}

async function pool(context, jobs, concurrency, worker) {
  let i = 0;
  const run = async () => {
    const page = await context.newPage();
    while (i < jobs.length) await worker(page, jobs[i++]);
    await page.close();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, run));
}

const readJson = async (f, fallback) => {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; }
};

function formatReport(diff) {
  const line = (it) =>
    `${it.faculty || '?'} > ${it.course || '?'} | ${it.title} | modified ${it.modifiedAt || it.date} | ${it.fileUrl || it.detailUrl}`;
  const out = [];
  if (diff.added.length) out.push(`NEW (${diff.added.length})`, ...diff.added.map((i) => `  + ${line(i)}`));
  if (diff.changed.length) {
    out.push(`CHANGED (${diff.changed.length})`);
    for (const c of diff.changed) out.push(`  ~ ${line(c.item)}  [${c.fields.join(', ')}]`);
  }
  if (diff.removed.length) out.push(`REMOVED (${diff.removed.length})`, ...diff.removed.map((i) => `  - ${line(i)}`));
  return out.join('\n');
}

async function notify(text) {
  const url = process.env.NOTIFY_WEBHOOK;
  if (!url) return;
  try {
    const body = text.length > 1800 ? `${text.slice(0, 1800)}\n...` : text;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: body, content: body }),
    });
  } catch (e) {
    log('webhook failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Stage 1: exam form dates (separate ASP.NET site, a plain grid with COURSE / STATUS / dates columns)
// ---------------------------------------------------------------------------
const EXAM_URL = process.env.EXAM_URL || 'https://examform.unipune.ac.in/Support/StuExDates.aspx';

/** Find the grid whose header row has a COURSE cell; returns { header, rows } or null. */
const readExamTable = (page) =>
  page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let best = null;
    for (const t of document.querySelectorAll('table')) {
      const rows = [...t.rows]; // only this table's own rows, nested pager tables are not included
      const hi = rows.findIndex((r) => {
        const cells = [...r.cells].map((c) => norm(c.textContent).toLowerCase());
        return cells.length >= 3 && cells.includes('course');
      });
      if (hi < 0) continue;
      const header = [...rows[hi].cells].map((c) => norm(c.textContent));
      const data = rows
        .slice(hi + 1)
        .filter((r) => r.cells.length === header.length) // drops the pager / footer rows
        .map((r) => [...r.cells].map((c) => norm(c.textContent)));
      if (!best || data.length > best.rows.length) best = { header, rows: data };
    }
    return best;
  });

const examSig = (t) => (t ? `${t.rows.length}:${JSON.stringify(t.rows[0] ?? [])}` : '');

/** Click GridView pager link for page n (or the "..." link to reveal more numbers). */
async function clickExamPager(page, n) {
  const links = page.locator('a[href*="__doPostBack"]');
  let target = links.filter({ hasText: new RegExp(`^\\s*${n}\\s*$`) });
  if ((await target.count()) > 0) target = target.first();
  else {
    target = links.filter({ hasText: /^\s*\.\.\.\s*$/ });
    if ((await target.count()) === 0) return false;
    target = target.last();
  }
  await target.click();
  return true;
}

/** After a pager click (full postback or UpdatePanel) wait until the grid shows different rows. */
async function waitForExamChange(page, before) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const t = await readExamTable(page);
      if (t && examSig(t) !== before) return t;
    } catch { /* context destroyed mid-navigation: retry */ }
  }
  return null;
}

async function scrapeExamDates(context, outDir, delay) {
  const page = await context.newPage();
  try {
    await goto(page, EXAM_URL);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await fs.mkdir(path.join(outDir, 'debug'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'debug', 'exam-dates-0.html'), await page.content());

    let table = await readExamTable(page);
    if (!table) throw new Error('dates table (COURSE column) not found; page layout changed?');
    const header = table.header;
    const rows = [...table.rows];
    const seen = new Set(rows.map((r) => JSON.stringify(r)));

    for (let n = 2; n <= 50; n++) {
      const before = examSig(table);
      if (!(await clickExamPager(page, n))) break;
      const t = await waitForExamChange(page, before);
      if (!t) break;
      const fresh = t.rows.filter((r) => !seen.has(JSON.stringify(r)));
      if (!fresh.length) break;
      for (const r of fresh) { seen.add(JSON.stringify(r)); rows.push(r); }
      table = t;
      await sleep(delay);
    }
    return { header, rows };
  } finally {
    await page.close();
  }
}

/** Runs stage 1. Never throws: a failure here must not block the circulars crawl. */
async function runExamDates(context, opt) {
  const dir = path.join(opt.out, 'exam');
  await fs.mkdir(path.join(dir, 'changes'), { recursive: true });
  const statePath = path.join(dir, 'state.json');
  const prev = await readJson(statePath, null);
  const oldItems = prev?.items ?? {};

  let items;
  try {
    log(`exam dates: ${EXAM_URL}`);
    const { header, rows } = await scrapeExamDates(context, opt.out, opt.delay);
    items = rowsToItems(header, rows);
    if (!Object.keys(items).length) throw new Error('table found but it has no data rows');
  } catch (e) {
    log(`exam dates: FAILED (${e.message.split('\n')[0]}); keeping previous state`);
    return { ok: false, changed: false };
  }

  const now = new Date().toISOString();
  const diff = diffExamDates(oldItems, items);
  const all = Object.values(items).sort(byStartDesc);
  await fs.writeFile(statePath, JSON.stringify({ updatedAt: now, items }, null, 2));
  await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(all, null, 2));
  await fs.writeFile(path.join(dir, 'latest.csv'), toExamCsv(all));

  const active = all.filter((i) => i.active).length;
  log(`exam dates: ${all.length} windows (${active} active)`);
  for (const { item, next } of upcomingDeadlines(all, nowIst(), 7)) {
    log(`  due soon: ${item.course} -> ${next.label} ${next.raw}`);
  }

  if (!prev) {
    log('exam dates: baseline created (first run)');
    return { ok: true, changed: false };
  }
  const total = Object.values(diff).reduce((n, a) => n + a.length, 0);
  if (!total) {
    log('exam dates: no changes');
    return { ok: true, changed: false };
  }
  // a window closing by itself when its deadline passes is recorded, but is not worth a webhook
  const loud = diff.added.length + diff.changed.length + diff.reopened.length + diff.removed.length > 0;
  const report = formatExamReport(diff);
  console.log(`\n${report}\n`);
  await fs.writeFile(
    path.join(dir, 'changes', `${now.replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ at: now, ...diff }, null, 2),
  );
  if (loud) await notify(`SPPU exam form date updates (${now})\n${report}`);
  return { ok: true, changed: loud };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  await fs.mkdir(path.join(opt.out, 'changes'), { recursive: true });
  const statePath = path.join(opt.out, 'state.json');
  const prev = await readJson(statePath, null);
  const oldItems = prev?.items ?? {};
  const firstRun = !prev;

  const browser = await chromium.launch({ headless: !opt.headed });
  const makeContext = async (extra = {}) => {
    const ctx = await browser.newContext(extra);
    await ctx.route('**/*', (r) =>
      ['image', 'stylesheet', 'font', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue());
    return ctx;
  };
  const context = await makeContext();

  const newItems = {};
  const listedKeys = new Set();
  const scopedLibraries = new Set();
  let failures = 0;

  try {
    // Stage 1: exam form dates (different site, so it goes first and is independent of the crawl below)
    if (!opt.listLibs && !opt.noExam) {
      const ex = await runExamDates(context, opt);
      if (ex.changed && opt.failOnChange) process.exitCode = 10;
    }
    if (opt.examOnly) return;

    // Stage 2: circulars / timetables
    const first = await context.newPage();
    const discovered = await discoverLibraries(makeContext, opt.out);
    log(`found ${discovered.length} document libraries`);

    const JUNK = /^(test\d*|site assets|site pages|style library)$/i;
    const skipped = [];
    const libs = discovered.filter((l) => {
      let why = null;
      if (!opt.all && JUNK.test(l.name)) why = 'junk library (use --all to include)';
      else if (opt.since) {
        const y = yearOf(l.name);
        if (y !== null && y < opt.since) why = `year ${y} < --since ${opt.since}`;
      }
      if (!why && opt.match && !opt.match.test(l.name)) why = 'does not match --match';
      if (why) skipped.push({ name: l.name, why });
      return !why;
    });

    await fs.writeFile(
      path.join(opt.out, 'libraries.json'),
      JSON.stringify({ discovered, selected: libs.map((l) => l.name), skipped }, null, 2),
    );
    log(`selected ${libs.length}, skipped ${skipped.length}`);
    for (const s of skipped) log(`  skip: ${s.name} (${s.why})`);
    if (opt.listLibs) {
      for (const l of libs) console.log(`  ${l.name}  ->  ${l.url}`);
      return;
    }
    log(`crawling: ${libs.map((l) => l.name).join(' | ')}`);

    for (const lib of libs) {
      let ids;
      try {
        ids = await listItems(first, lib, opt.delay, opt.out);
      } catch (e) {
        failures++;
        log(`${lib.name}: FAILED to list (${e.message.split('\n')[0]}); keeping previous state for it`);
        continue; // not added to scopedLibraries, so its old items are never reported as removed
      }
      scopedLibraries.add(lib.name);
      const jobs = [];
      for (const [id, { url, folder }] of ids) {
        const key = `${lib.name}#${id}`;
        listedKeys.add(key);
        if (opt.fast && oldItems[key]) newItems[key] = oldItems[key];
        else jobs.push({ id, url, folder, key });
      }
      log(`${lib.name}: ${ids.size} items, opening ${jobs.length} detail pages`);
      await pool(context, jobs, opt.concurrency, async (page, job) => {
        try {
          newItems[job.key] = await scrapeItem(page, lib, job.id, job.url, job.folder);
        } catch (e) {
          failures++;
          log(`  ! ${job.key}: ${e.message.split('\n')[0]}`);
          if (oldItems[job.key]) newItems[job.key] = oldItems[job.key]; // keep last known good
        }
        await sleep(opt.delay);
      });
    }
  } finally {
    await browser.close();
  }

  const now = new Date().toISOString();
  const diff = diffItems(oldItems, newItems, { scopedLibraries, listedKeys });
  const removedKeys = new Set(diff.removed.map((r) => r.key));
  const merged = { ...Object.fromEntries(Object.entries(oldItems).filter(([k]) => !removedKeys.has(k))), ...newItems };
  const all = Object.values(merged).sort(byLatest);

  await fs.writeFile(statePath, JSON.stringify({ updatedAt: now, items: merged }, null, 2));
  await fs.writeFile(path.join(opt.out, 'latest.json'), JSON.stringify(all, null, 2));
  await fs.writeFile(path.join(opt.out, 'by_faculty.json'), JSON.stringify(groupByFacultyCourse(all), null, 2));
  await fs.writeFile(path.join(opt.out, 'latest.csv'), toCsv(all));

  const changed = diff.added.length + diff.changed.length + diff.removed.length > 0;
  log(`done: ${all.length} items total, ${failures} failed page loads`);

  if (firstRun) {
    log('baseline created (first run), nothing to compare against yet');
    return;
  }
  if (!changed) {
    log('no changes');
    return;
  }
  const report = formatReport(diff);
  console.log(`\n${report}\n`);
  await fs.writeFile(
    path.join(opt.out, 'changes', `${now.replace(/[:.]/g, '-')}.json`),
    JSON.stringify({ at: now, ...diff }, null, 2),
  );
  await notify(`SPPU exam circular updates (${now})\n${report}`);
  if (opt.failOnChange) process.exitCode = 10;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});