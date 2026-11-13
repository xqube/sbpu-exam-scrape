#!/usr/bin/env node
/**
 * Telegram bot (grammY) for the SPPU watcher.
 *
 *  - Commands to browse circulars / timetables and exam form dates.
 *  - Pushes notifications when scrape.js records changes
 *      data/exam/changes/*.json   (exam form dates, stage 1 of the scraper)
 *      data/changes/*.json        (circulars / timetables, stage 2)
 *  - Sends deadline reminders for active exam form windows.
 *  - Optionally runs scrape.js itself on a timer (SCRAPE_INTERVAL_MIN), or leave that at 0
 *    and keep running the scraper from cron / GitHub Actions: the bot just watches the data folder.
 *
 * Env (a .env file in this folder is loaded automatically on Node >= 20.6):
 *   BOT_TOKEN            required, from @BotFather
 *   ADMIN_IDS            comma separated Telegram user ids allowed to use /check and /broadcast
 *   DATA_DIR             scraper output folder (default ./data)
 *   POLL_SECONDS         how often to look for new change files (default 60)
 *   SCRAPE_INTERVAL_MIN  run scrape.js every N minutes from inside the bot (default 0 = off)
 *   SCRAPE_ARGS          arguments for scrape.js (default "--fast")
 *   REMIND_HOURS         reminder thresholds before an exam deadline (default "24,3")
 *   NOTIFY_CLOSED        "1" to also announce exam windows that simply closed (default off)
 *   SITE_TZ_OFFSET_MIN   timezone of the exam site relative to UTC in minutes (default 330, IST)
 */
import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { autoRetry } from "@grammyjs/auto-retry";
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nowIst, upcomingDeadlines, hoursUntil } from './examlib.js';
import { groupByFacultyCourse } from './lib.js';
import {
  esc, chunkBlocks, parseKeywords, matchesWatch, searchCirculars, searchExams,
  formatCircular, formatExam, circularChangeBlocks, examChangeBlocks, reminderBlock,
} from './botlib.js';

try { process.loadEnvFile?.('.env'); } catch { /* no .env file */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN is not set (get one from @BotFather, put it in .env or the environment).');
  process.exit(1);
}
const DATA = path.resolve(process.env.DATA_DIR || 'data');
const STATE_FILE = path.join(DATA, 'bot-state.json');
const CHANGES = { exams: path.join(DATA, 'exam', 'changes'), circulars: path.join(DATA, 'changes') };
const ADMINS = new Set((process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const POLL_MS = Math.max(10, Number(process.env.POLL_SECONDS || 60)) * 1000;
const SCRAPE_EVERY_MS = Number(process.env.SCRAPE_INTERVAL_MIN || 0) * 60_000;
const SCRAPE_ARGS = (process.env.SCRAPE_ARGS || '--fast').split(/\s+/).filter(Boolean);
const REMIND_HOURS = (process.env.REMIND_HOURS || '24,3').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const NOTIFY_CLOSED = process.env.NOTIFY_CLOSED === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[bot]', ...a);
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
const listJson = async (dir) => {
  try { return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
};
const getCirculars = () => readJson(path.join(DATA, 'latest.json'), []);
const getExams = () => readJson(path.join(DATA, 'exam', 'latest.json'), []);

// ---------------------------------------------------------------------------
// Persistent bot state: subscribers (+ their keyword filters), change cursors, sent reminders
// ---------------------------------------------------------------------------
let state = { subscribers: {}, cursor: {}, reminded: [] };
let saving = Promise.resolve();
const saveState = () =>
  (saving = saving.then(async () => {
    await fs.mkdir(DATA, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, STATE_FILE);
  }).catch((e) => log('could not save state:', e.message)));

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
const bot = new Bot(TOKEN);
bot.api.config.use(autoRetry());
const OPTS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/** Push a message to a chat. Drops subscribers who blocked the bot. Retries on flood limits. */
async function send(chatId, html) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bot.api.sendMessage(Number(chatId), html, OPTS);
      return true;
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.error_code === 429) {
          await sleep(((e.parameters?.retry_after ?? 5) + 1) * 1000);
          continue;
        }
        if (e.error_code === 403 || (e.error_code === 400 && /chat not found/i.test(e.description))) {
          delete state.subscribers[chatId];
          await saveState();
          log(`removed ${chatId} (${e.description})`);
          return false;
        }
      }
      log(`send to ${chatId} failed: ${e.message}`);
      return false;
    }
  }
  return false;
}

async function sendBlocks(chatId, blocks) {
  for (const chunk of chunkBlocks(blocks)) {
    if (!(await send(chatId, chunk))) return false;
    await sleep(60); // stay well under Telegram's ~30 msgs/sec global limit
  }
  return true;
}

const replyBlocks = async (ctx, blocks) => {
  for (const chunk of chunkBlocks(blocks)) await ctx.reply(chunk, OPTS);
};

const isAdmin = (ctx) => ADMINS.has(String(ctx.from?.id));
const alertAdmins = (text) => Promise.all([...ADMINS].map((id) => send(id, esc(text))));

function ensureSub(ctx) {
  const id = String(ctx.chat.id);
  const created = !state.subscribers[id];
  state.subscribers[id] ??= {
    watch: [],
    since: new Date().toISOString(),
    name: ctx.from?.username || ctx.from?.first_name || ctx.chat.title || '',
  };
  return { sub: state.subscribers[id], created };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
async function broadcastDiff(kind, diff) {
  const header = kind === 'exams' ? '📢 <b>SPPU exam form dates</b>' : '📢 <b>SPPU circulars / timetables</b>';
  let sent = 0;
  for (const [chatId, sub] of Object.entries(state.subscribers)) {
    const blocks = kind === 'exams'
      ? examChangeBlocks(diff, sub.watch, { includeClosed: NOTIFY_CLOSED })
      : circularChangeBlocks(diff, sub.watch);
    if (!blocks.length) continue;
    if (await sendBlocks(chatId, [header, ...blocks])) sent++;
  }
  log(`${kind}: notified ${sent}/${Object.keys(state.subscribers).length} subscribers`);
}

/** Look for change files the scraper wrote since the last one we announced. Exam dates go first. */
async function pollChanges() {
  for (const kind of ['exams', 'circulars']) {
    const files = await listJson(CHANGES[kind]);
    if (state.cursor[kind] === undefined) {
      // first start: don't replay history, only announce what happens from now on
      state.cursor[kind] = files.at(-1) ?? '';
      await saveState();
      continue;
    }
    for (const f of files.filter((x) => x > state.cursor[kind])) {
      const diff = await readJson(path.join(CHANGES[kind], f), null);
      if (diff) await broadcastDiff(kind, diff);
      state.cursor[kind] = f;
      await saveState();
    }
  }
}

/** One reminder per (window, deadline, threshold); the tightest threshold already crossed wins. */
async function sendReminders() {
  if (!REMIND_HOURS.length) return;
  const now = nowIst();
  const due = upcomingDeadlines(await getExams(), now, Math.max(...REMIND_HOURS) / 24);
  for (const { item, next } of due) {
    const left = hoursUntil(next.iso, now);
    const t = REMIND_HOURS.find((h) => left <= h);
    if (t === undefined) continue;
    const id = `${item.key}|${next.iso}|${t}`;
    if (state.reminded.includes(id)) continue;
    for (const h of REMIND_HOURS.filter((x) => x >= t)) state.reminded.push(`${item.key}|${next.iso}|${h}`);
    await saveState();
    const block = reminderBlock(item, next, now);
    for (const [chatId, sub] of Object.entries(state.subscribers)) {
      if (matchesWatch(sub.watch, item.course)) await send(chatId, block);
    }
  }
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 16);
  state.reminded = state.reminded.filter((id) => (id.split('|')[1] || '') >= cutoff);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await pollChanges();
    await sendReminders();
  } catch (e) {
    log('tick failed:', e.message);
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Running the scraper from inside the bot (optional)
// ---------------------------------------------------------------------------
let scraping = false;
function runScrape() {
  return new Promise((resolve) => {
    if (scraping) return resolve({ ok: false, reason: 'a scrape is already running' });
    scraping = true;
    const args = [path.join(__dirname, 'scrape.js'), ...SCRAPE_ARGS];
    if (!SCRAPE_ARGS.includes('--out')) args.push('--out', DATA);
    log(`scrape: node ${args.map((a) => path.basename(a)).join(' ')}`);
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: ['ignore', 'inherit', 'inherit'] });
    const done = (r) => { scraping = false; resolve(r); };
    child.on('error', (e) => done({ ok: false, reason: e.message }));
    child.on('close', (code) => done({ ok: code === 0, reason: `exit code ${code}` }));
  });
}

async function scrapeLoop() {
  for (;;) {
    const r = await runScrape();
    if (!r.ok) await alertAdmins(`Scheduled scrape failed: ${r.reason}`);
    await tick();
    await sleep(SCRAPE_EVERY_MS);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const HELP = [
  '<b>SPPU exam watcher</b>',
  'I notify you about new circulars / timetables and exam form dates, and remind you before deadlines.',
  [
    '<b>Notifications</b>',
    '/subscribe, /unsubscribe: turn alerts on or off',
    '/watch &lt;words&gt;: only alert for matching items, e.g. <code>/watch B.Sc, Law</code>',
    '/unwatch &lt;word|all&gt;, /status',
  ].join('\n'),
  [
    '<b>Exam form dates</b>',
    '/exams: active exam form windows',
    '/exam &lt;text&gt;: search any window by course name',
    '/deadlines [days]: deadlines coming up (default 7 days)',
  ].join('\n'),
  [
    '<b>Circulars / timetables</b>',
    '/latest [n]: newest uploads',
    '/search &lt;text&gt;: e.g. <code>/search M.Sc physics</code>',
    '/faculties: browse by faculty',
    '/mine: latest items matching your /watch words',
  ].join('\n'),
];

const COMMANDS = [
  ['start', 'Subscribe and show help'],
  ['help', 'Show help'],
  ['subscribe', 'Turn notifications on'],
  ['unsubscribe', 'Turn notifications off'],
  ['watch', 'Only notify for matching words'],
  ['unwatch', 'Remove watch words'],
  ['status', 'Subscription and data status'],
  ['exams', 'Active exam form windows'],
  ['exam', 'Search exam form windows'],
  ['deadlines', 'Upcoming exam form deadlines'],
  ['latest', 'Newest circulars / timetables'],
  ['search', 'Search circulars / timetables'],
  ['faculties', 'Browse by faculty'],
  ['mine', 'Latest items matching your watch words'],
];

const NO_DATA = 'No data yet. Run <code>node scrape.js</code> first (or ask the admin to /check).';

bot.command('start', async (ctx) => {
  const { created } = ensureSub(ctx);
  await saveState();
  await replyBlocks(ctx, [
    ...HELP,
    created ? '✅ You are now <b>subscribed</b> to alerts. Use /unsubscribe to stop.' : 'You are already subscribed.',
  ]);
});
bot.command('help', (ctx) => replyBlocks(ctx, HELP));

bot.command('subscribe', async (ctx) => {
  const { created } = ensureSub(ctx);
  await saveState();
  await ctx.reply(created ? '✅ Subscribed.' : 'You are already subscribed.');
});
bot.command('unsubscribe', async (ctx) => {
  const had = delete state.subscribers[String(ctx.chat.id)];
  await saveState();
  await ctx.reply(had ? 'Unsubscribed. Use /subscribe to come back.' : 'You were not subscribed.');
});

bot.command('watch', async (ctx) => {
  const { sub } = ensureSub(ctx);
  const words = parseKeywords(ctx.match);
  if (words.length) {
    sub.watch = [...new Set([...sub.watch, ...words])].slice(0, 20);
    await saveState();
  }
  await ctx.reply(
    sub.watch.length
      ? `Alerts only for items matching: ${sub.watch.join(', ')}`
      : 'No watch words set, so you get everything. Add some: /watch B.Sc, Law',
  );
});
bot.command('unwatch', async (ctx) => {
  const { sub } = ensureSub(ctx);
  const arg = String(ctx.match || '').trim().toLowerCase();
  if (arg === 'all') sub.watch = [];
  else {
    const drop = new Set(parseKeywords(arg));
    sub.watch = sub.watch.filter((w) => !drop.has(w));
  }
  await saveState();
  await ctx.reply(sub.watch.length ? `Watching: ${sub.watch.join(', ')}` : 'Watch list cleared: you get everything.');
});

bot.command('status', async (ctx) => {
  const sub = state.subscribers[String(ctx.chat.id)];
  const [c, e] = await Promise.all([
    readJson(path.join(DATA, 'state.json'), null),
    readJson(path.join(DATA, 'exam', 'state.json'), null),
  ]);
  const ago = (iso) => (iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'never');
  await ctx.reply([
    sub ? `Subscribed ✅${sub.watch.length ? ` (watching: ${sub.watch.join(', ')})` : ''}` : 'Not subscribed. Use /subscribe',
    `Exam dates last updated: ${ago(e?.updatedAt)} (${Object.keys(e?.items ?? {}).length} windows)`,
    `Circulars last updated: ${ago(c?.updatedAt)} (${Object.keys(c?.items ?? {}).length} items)`,
    `Subscribers: ${Object.keys(state.subscribers).length}`,
  ].join('\n'));
});

// ---- exam form dates ------------------------------------------------------
const MAX_LIST = 15;
const more = (shown, total, hint) => (total > shown ? [`…${total - shown} more. ${hint}`] : []);

bot.command('exams', async (ctx) => {
  const all = await getExams();
  if (!all.length) return ctx.reply(NO_DATA, OPTS);
  const active = all.filter((i) => i.active);
  if (!active.length) return ctx.reply('No exam form window is active right now. Try /exam <text> to see closed ones.');
  const now = nowIst();
  await replyBlocks(ctx, [
    `<b>Active exam form windows (${active.length})</b>`,
    ...active.slice(0, MAX_LIST).map((i) => formatExam(i, now)),
    ...more(MAX_LIST, active.length, 'Narrow it down with /exam &lt;text&gt;.'),
  ]);
});

bot.command('exam', async (ctx) => {
  const q = String(ctx.match || '').trim();
  if (!q) return ctx.reply('Usage: /exam <part of course name>, e.g. /exam B.Sc');
  const all = await getExams();
  if (!all.length) return ctx.reply(NO_DATA, OPTS);
  const hits = searchExams(all, q, 1000);
  if (!hits.length) return ctx.reply(`Nothing found for "${q}".`);
  const now = nowIst();
  await replyBlocks(ctx, [
    `<b>${hits.length} match(es) for "${esc(q)}"</b>`,
    ...hits.slice(0, MAX_LIST).map((i) => formatExam(i, now)),
    ...more(MAX_LIST, hits.length, 'Be more specific.'),
  ]);
});

bot.command('deadlines', async (ctx) => {
  const days = Math.min(90, Math.max(1, Number(ctx.match) || 7));
  const all = await getExams();
  if (!all.length) return ctx.reply(NO_DATA, OPTS);
  const now = nowIst();
  const due = upcomingDeadlines(all, now, days);
  if (!due.length) return ctx.reply(`No active exam form deadlines in the next ${days} day(s).`);
  await replyBlocks(ctx, [
    `<b>Deadlines in the next ${days} day(s) (${due.length})</b>`,
    ...due.slice(0, 25).map(({ item, next }) => `⏳ <b>${esc(item.course)}</b>\n${esc(next.label)}: ${esc(next.raw)}`),
    ...more(25, due.length, 'Use a smaller range.'),
  ]);
});

// ---- circulars / timetables ----------------------------------------------
bot.command('latest', async (ctx) => {
  const n = Math.min(MAX_LIST, Math.max(1, Number(ctx.match) || 5));
  const all = await getCirculars();
  if (!all.length) return ctx.reply(NO_DATA, OPTS);
  await replyBlocks(ctx, [`<b>Latest ${Math.min(n, all.length)} uploads</b>`, ...all.slice(0, n).map(formatCircular)]);
});

bot.command('search', async (ctx) => {
  const q = String(ctx.match || '').trim();
  if (!q) return ctx.reply('Usage: /search <words>, e.g. /search M.Sc physics');
  const all = await getCirculars();
  if (!all.length) return ctx.reply(NO_DATA, OPTS);
  const hits = searchCirculars(all, q, 10); // `all` is newest-first already
  if (!hits.length) return ctx.reply(`Nothing found for "${q}".`);
  await replyBlocks(ctx, [`<b>Top ${hits.length} for "${esc(q)}"</b> (newest first)`, ...hits.map(formatCircular)]);
});

bot.command('mine', async (ctx) => {
  const sub = state.subscribers[String(ctx.chat.id)];
  if (!sub?.watch.length) return ctx.reply('You have no watch words yet. Add some: /watch B.Sc, Law');
  const [all, exams] = await Promise.all([getCirculars(), getExams()]);
  const now = nowIst();
  const items = all.filter((it) => matchesWatch(sub.watch, it.faculty, it.course, it.title, it.library, it.fileName)).slice(0, 8);
  const wins = exams.filter((it) => it.active && matchesWatch(sub.watch, it.course)).slice(0, 5);
  if (!items.length && !wins.length) return ctx.reply(`Nothing matches: ${sub.watch.join(', ')}`);
  await replyBlocks(ctx, [
    ...(wins.length ? ['<b>Active exam form windows</b>', ...wins.map((i) => formatExam(i, now))] : []),
    ...(items.length ? ['<b>Latest uploads</b>', ...items.map(formatCircular)] : []),
  ]);
});

const facultyList = async () => Object.keys(groupByFacultyCourse(await getCirculars()));

bot.command('faculties', async (ctx) => {
  const list = await facultyList();
  if (!list.length) return ctx.reply(NO_DATA, OPTS);
  const kb = new InlineKeyboard();
  list.forEach((f, i) => kb.text(f.slice(0, 60), `fac:${i}`).row());
  await ctx.reply('Pick a faculty:', { reply_markup: kb });
});

bot.callbackQuery(/^fac:(\d+)$/, async (ctx) => {
  const list = await facultyList();
  const name = list[Number(ctx.match[1])];
  await ctx.answerCallbackQuery();
  if (!name) return ctx.reply('That list changed, run /faculties again.');
  const items = (await getCirculars()).filter((it) => (it.faculty || '(no faculty)') === name).slice(0, 8);
  await replyBlocks(ctx, [`<b>${esc(name)}</b>: latest ${items.length}`, ...items.map(formatCircular)]);
});

// ---- admin ----------------------------------------------------------------
bot.command('check', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admins only.');
  if (scraping) return ctx.reply('A scrape is already running.');
  await ctx.reply(`Running scraper (${SCRAPE_ARGS.join(' ') || 'default options'})… this can take a while.`);
  const r = await runScrape();
  await tick();
  await ctx.reply(r.ok ? 'Scrape finished. Subscribers are notified if anything changed.' : `Scrape failed: ${r.reason}`);
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Admins only.');
  const text = String(ctx.match || '').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  let n = 0;
  for (const id of Object.keys(state.subscribers)) if (await send(id, `📣 ${esc(text)}`)) n++;
  await ctx.reply(`Sent to ${n} subscriber(s).`);
});

bot.on('message:text', (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Try /help for the list of commands.');
});

bot.catch((err) => log('handler error:', err.error?.message || err.message));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  state = { ...state, ...(await readJson(STATE_FILE, {})) };
  state.subscribers ??= {};
  state.cursor ??= {};
  state.reminded ??= [];

  const stop = async (sig) => {
    log(`${sig}, stopping`);
    await bot.stop();
    await saving;
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description })));
  await tick(); // sets cursors on first start
  setInterval(tick, POLL_MS);
  if (SCRAPE_EVERY_MS > 0) {
    log(`scraping every ${SCRAPE_EVERY_MS / 60_000} min`);
    scrapeLoop();
  }
  await bot.start({ onStart: (me) => log(`@${me.username} is up; ${Object.keys(state.subscribers).length} subscriber(s), data in ${DATA}`) });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
