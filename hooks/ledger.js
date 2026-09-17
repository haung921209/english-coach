#!/usr/bin/env node
// english-coach — the ledger: read, gap check, category tally.
//
// The ledger is append-only JSONL at `log_path`. Nothing here writes it; the
// model appends one line per correction, which keeps the hook out of the write
// path. This module is what makes a silent ledger visible: `gap()` is the
// answer to "the rule stopped running and nobody noticed for 34 days".

const fs = require('fs');

const SCHEMA_VERSION = 'english.pattern.v1';

// The gap check needs only the newest date, but the ledger is append-only and
// grows for the life of the install; parsing all of it on every session start
// is unbounded work inside a 5-second hook. Read the tail and scan backwards.
// -> { last, exists, readable } — `readable` false means bytes were there but
// no dated line could be found in the tail.
function lastDateFromTail(logPath, tailBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(logPath, 'r');
  } catch (e) {
    return { last: null, exists: false, readable: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return { last: null, exists: true, readable: true };
    const length = Math.min(size, tailBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    // A partial first line when the file is longer than the window.
    if (size > length) lines.shift();
    let last = null;
    let parsed = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const d = String(JSON.parse(t).date || '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          parsed += 1;
          if (!last || d > last) last = d;
        }
      } catch (e) { /* tolerate a bad line, same as load() */ }
    }
    return { last, exists: true, readable: parsed > 0 || lines.every(l => !l.trim()) };
  } catch (e) {
    return { last: null, exists: true, readable: false };
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* best effort */ }
  }
}

function load(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    return { items: [], exists: false, broken: 0 };
  }
  const items = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      items.push(JSON.parse(s));
    } catch (e) {
      // One bad line must not hide the rest — an append-only ledger is read
      // leniently on purpose.
      broken += 1;
    }
  }
  return { items, exists: true, broken };
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function lastDate(items) {
  let last = null;
  for (const it of items) {
    const d = String(it && it.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!last || d > last)) last = d;
  }
  return last;
}

// null when there is nothing to warn about, else {days, last, empty}.
// `empty` distinguishes "never written" from "written, then went quiet" —
// a fresh install should not be scolded for a gap it has not had time to open.
function gap(items, gapAlertDays, today = isoDate()) {
  if (!gapAlertDays || gapAlertDays <= 0) return null;
  const last = lastDate(items);
  if (!last) return items.length ? null : { days: null, last: null, empty: true };
  const days = daysBetween(last, today);
  if (days === null || days <= gapAlertDays) return null;
  return { days, last, empty: false };
}

function splitCats(item) {
  return String(item && item.cat || '?').split('+').map(s => s.trim()).filter(Boolean);
}

function kindOf(item) {
  // Entries written before `kind` existed are corrections.
  const k = item && item.kind;
  return (k === 'translate' || k === 'correct') ? k : 'correct';
}

function withinDays(item, days, today = isoDate()) {
  const d = String(item && item.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const n = daysBetween(d, today);
  return n !== null && n <= days;
}

// Port of the persona stats.py: frequency descending, because the point of the
// ledger is "which categories do I keep getting wrong", not browsing sentences.
function stats(items, { cat = null, recent = null, today = isoDate() } = {}) {
  let sel = items;
  if (recent) sel = sel.filter(i => withinDays(i, recent, today));
  if (!sel.length) {
    return recent ? `최근 ${recent}일 항목 없음`
                  : '원장이 비어 있다 — 영어 프롬프트 교정이 쌓이면 채워진다.';
  }
  if (cat) {
    const hits = sel.filter(i => splitCats(i).includes(cat));
    if (!hits.length) return `범주 '${cat}' 항목 없음`;
    const lines = [`${cat} — ${hits.length}건`, ''];
    for (const i of hits) {
      if (kindOf(i) === 'translate') lines.push(`  → ${i.right || ''}`);
      else {
        lines.push(`  ✗ ${i.wrong || ''}`);
        lines.push(`  ✓ ${i.right || ''}`);
      }
      lines.push(`    ${i.rule || ''}`);
      if (i.note) lines.push(`    note: ${i.note}`);
      lines.push('');
    }
    return lines.join('\n');
  }
  const counts = new Map();
  for (const i of sel) for (const c of splitCats(i)) counts.set(c, (counts.get(c) || 0) + 1);
  const ordered = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const width = Math.max(3, ...ordered.map(([c]) => c.length));
  const total = ordered.reduce((n, [, v]) => n + v, 0);
  const byKind = sel.reduce((m, i) => (m[kindOf(i)] = (m[kindOf(i)] || 0) + 1, m), {});
  const lines = [
    `총 ${sel.length}건 (correct ${byKind.correct || 0} · translate ${byKind.translate || 0}) · 범주 태그 ${total}개`,
    '',
  ];
  for (const [c, n] of ordered) lines.push(`  ${c.padEnd(width)}  ${String(n).padStart(3)}  ${'█'.repeat(n)}`);
  lines.push('', '상위 2~3개만 드릴한다. 전 범주를 고르게 보려 하면 아무것도 안 남는다.');
  return lines.join('\n');
}

module.exports = { SCHEMA_VERSION, load, stats, gap, lastDateFromTail, kindOf, isoDate };

// Also usable straight from a shell, so the tally is not locked behind a
// session: `node hooks/ledger.js [--cat modal] [--recent 30]`
if (require.main === module) {
  const { load: loadCfg } = require('./config');
  const argv = process.argv.slice(2);
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const cfg = loadCfg();
  const { items, exists } = load(cfg.log_path);
  if (!exists) console.log(`원장 없음: ${cfg.log_path}`);
  const recent = arg('--recent');
  console.log(stats(items, { cat: arg('--cat'), recent: recent ? Number(recent) : null }));
}
