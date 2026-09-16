#!/usr/bin/env node
// english-coach — UserPromptSubmit hook.
//
// Runs the gate on every prompt and, when it fires, tells the model exactly
// what correction to append and where to record it. Also the entry point for
// `/english ...`, so settings are changeable from inside a session.
//
// This hook never blocks: it only ever adds context. A language tool that can
// stall the actual work gets deleted within a week.

const { load: loadConfig, configPath, coerce, set, KEYS, CATEGORIES, DEFAULTS, ENUMS } = require('./config');
const { classify } = require('./detect');
const { load: loadLedger, stats, isoDate, SCHEMA_VERSION } = require('./ledger');

function emit(context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

const STRICTNESS = {
  strict: 'strict — wrong, awkward, AND better-phrasing suggestions (a correct sentence a native speaker still would not write). The suggestion axis is separate from error correction; it can fire with nothing wrong.',
  normal: 'normal — anything whose meaning wobbles or is clearly unnatural. Do NOT upgrade phrasing that already works.',
  loose:  'loose — only what misleads or does not land. Let articles and prepositions go.',
};

const OUTPUT = {
  inline: 'Show the corrections at the end of your answer. Do NOT write the ledger.',
  file:   'Do NOT show corrections in your answer — stay silent about them. Append them to the ledger only.',
  both:   'Show the corrections at the end of your answer AND append them to the ledger.',
};

function ledgerInstruction(cfg, kind) {
  if (cfg.output === 'inline') return null;
  const shape = kind === 'translate'
    ? `{"schemaVersion":"${SCHEMA_VERSION}","date":"${isoDate()}","kind":"translate","cat":"<category>","wrong":"","right":"<the English sentence>","rule":"<one line>","note":""}`
    : `{"schemaVersion":"${SCHEMA_VERSION}","date":"${isoDate()}","kind":"correct","cat":"<category>","wrong":"<neutralised original>","right":"<natural version>","rule":"<one line>","note":""}`;
  return `Append one line per item to ${cfg.log_path} (append-only JSONL; create the directory if needed), each exactly this shape: ${shape}`;
}

function correctionContext(cfg, kind) {
  const lines = [
    'ENGLISH-COACH: this prompt is in English. Do the requested work first and in full — the correction goes at the very end and never delays or replaces the work.',
    `Strictness: ${STRICTNESS[cfg.strictness]}`,
    `At most ${cfg.max_items} item(s). Fewer is better; nothing worth saying means say nothing.`,
    `Format per item: "✗ <original> / ✓ <natural> / <one-line rule>" with the rule written in ${cfg.explain_lang === 'ko' ? 'Korean' : 'English'}.`,
    'Neutralise before recording: replace product, company, system and person names, issue numbers and keys with X / the service / the job. The grammar pattern is the asset; the domain noun is not.',
    `Tag every item with a category from: ${CATEGORIES.join(', ')}. Join multiple with "+". An untagged item is unusable later, so a category is mandatory.`,
    `Routing: ${OUTPUT[cfg.output]}`,
  ];
  if (cfg.focus.length) lines.push(`Focus: report only these categories — ${cfg.focus.join(', ')}. Ignore everything else.`);
  const led = ledgerInstruction(cfg, kind);
  if (led) lines.push(led);
  return lines.join('\n');
}

function translateContext(cfg) {
  return [
    'ENGLISH-COACH: this prompt is Korean and long enough to be worth a rehearsal. Do the requested work first and in full.',
    'Then, at the very end, add ONE sentence: the English the user would have written for this request. Label it so it is obviously a rehearsal, not part of the answer.',
    `Add a one-line note in ${cfg.explain_lang === 'ko' ? 'Korean' : 'English'} naming the pattern worth keeping (the phrasing choice, not a translation gloss).`,
    'Neutralise domain nouns: product, company, system and person names, issue numbers and keys become X / the service / the job.',
    `Tag it with one category from: ${CATEGORIES.join(', ')}.`,
    `Routing: ${OUTPUT[cfg.output]}`,
    ledgerInstruction(cfg, 'translate'),
  ].filter(Boolean).join('\n');
}

function statusText(cfg) {
  const s = cfg._source || {};
  const lines = ['ENGLISH-COACH STATUS — report this to the user verbatim.', ''];
  for (const k of KEYS) {
    const v = Array.isArray(cfg[k]) ? (cfg[k].length ? cfg[k].join(',') : '[]') : cfg[k];
    const def = Array.isArray(DEFAULTS[k]) ? (DEFAULTS[k].length ? DEFAULTS[k].join(',') : '[]') : DEFAULTS[k];
    lines.push(`  ${k.padEnd(16)} ${String(v).padEnd(42)} [${s[k] || 'default'}]${s[k] === 'default' ? '' : ` default=${def}`}`);
  }
  lines.push('', `config file: ${configPath()}`, 'resolution: env ENGLISH_COACH_<KEY> > config file > default',
    'change: /english <key> <value>   ·   tally: /english stats [category]');
  return lines.join('\n');
}

function handleCommand(cfg, args) {
  const [head, ...rest] = args;

  if (!head || head === 'status') return statusText(cfg);

  if (head === 'stats') {
    const { items, exists, broken } = loadLedger(cfg.log_path);
    const cat = rest.find(a => !a.startsWith('--')) || null;
    const ri = rest.indexOf('--recent');
    const recent = ri >= 0 && rest[ri + 1] ? Number(rest[ri + 1]) : null;
    const head2 = exists ? `ENGLISH-COACH STATS — ${cfg.log_path}` : `ENGLISH-COACH STATS — no ledger yet at ${cfg.log_path}`;
    const warn = broken ? `\n(${broken} unparseable line(s) skipped)` : '';
    return `${head2}${warn}\n\n${stats(items, { cat, recent })}\n\nReport this to the user verbatim.`;
  }

  // `/english on` and `/english off` are shorthand for the enabled key — the
  // kill switch has to be the shortest thing to type.
  const [key, ...vals] = (head === 'on' || head === 'off') ? ['enabled', head] : [head, ...rest];
  if (!KEYS.includes(key)) {
    return `ENGLISH-COACH: unknown key '${key}'. Valid keys: ${KEYS.join(', ')}. Tell the user.`;
  }
  if (!vals.length) {
    const cur = Array.isArray(cfg[key]) ? (cfg[key].length ? cfg[key].join(',') : '[]') : cfg[key];
    const allowed = ENUMS[key] ? ` (${ENUMS[key].join('|')})` : '';
    return `ENGLISH-COACH: ${key} = ${cur}${allowed}. Usage: /english ${key} <value>. Tell the user.`;
  }
  const r = set(key, vals.join(','));
  if (!r.ok) return `ENGLISH-COACH: rejected — ${r.why}. Tell the user; nothing was changed.`;
  const shown = Array.isArray(r.value) ? (r.value.length ? r.value.join(',') : '[]') : r.value;
  const shadow = r.shadowed ? ` WARNING: ${r.shadowed} is set in the environment and still overrides it.` : '';
  return `ENGLISH-COACH: ${key} = ${shown}, saved to ${r.path}.${shadow} Tell the user, then carry on with whatever else they asked.`;
}

function run(raw) {
  let prompt = '';
  try {
    prompt = String(JSON.parse(String(raw).replace(/^﻿/, '')).prompt || '');
  } catch (e) {
    return; // malformed stdin: stay out of the way
  }

  const cfg = loadConfig();

  // Commands are handled even when disabled, or `/english on` could not reach us.
  const cmd = prompt.trim().match(/^\/(?:english-coach:)?english\b\s*(.*)$/is);
  if (cmd) {
    const args = cmd[1].trim().toLowerCase().split(/\s+/).filter(Boolean);
    return emit(handleCommand(cfg, args));
  }

  if (cfg.enabled === 'off') return;

  const { verdict } = classify(prompt, cfg);
  if (verdict === 'correct') return emit(correctionContext(cfg, 'correct'));
  if (verdict === 'mixed') {
    if (cfg.mixed_mode === 'translate') return emit(translateContext(cfg));
    if (cfg.mixed_mode === 'correct') return emit(correctionContext(cfg, 'correct'));
  }
  // skip: no output, no noise
}

let input = '';
let done = false;
function finish() {
  if (done) return;
  done = true;
  try { run(input); } catch (e) { /* never block the prompt */ }
}
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', finish);
// Never hang a session waiting on stdin that will not close. unref() keeps the
// timer off the normal path, where 'end' fires first.
process.stdin.on('error', () => { finish(); process.exit(0); });
setTimeout(() => { finish(); process.exit(0); }, 1000).unref();
