#!/usr/bin/env node
// english-coach — UserPromptSubmit hook.
//
// Runs the gate on every prompt and, when it fires, tells the model exactly
// what correction to append and where to record it. Also the entry point for
// `/english-coach ...`, so settings are changeable from inside a session.
//
// This hook never blocks: it only ever adds context. A language tool that can
// stall the actual work gets deleted within a week. It also never stays silent
// about its own failure — silence here is indistinguishable from "the plugin is
// not installed", which is what the command file tells the model to report.

const { load: loadConfig, configPath, set, KEYS, CATEGORIES, DEFAULTS, ENUMS } = require('./config');
const { classify } = require('./detect');
const { load: loadLedger, stats, isoDate, SCHEMA_VERSION } = require('./ledger');

function emit(context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  }));
}

// A config value as a user should read it: lists join, empty list shows as [].
function show(v) {
  if (!Array.isArray(v)) return v;
  return v.length ? v.join(',') : '[]';
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

// `mixed` means the gate measured this prompt as NOT English (ratio below
// min_en_ratio). Under mixed_mode: correct we still want a correction pass, but
// the opening line has to say what is actually true — telling the model a
// Korean prompt "is in English" makes it invent English to correct.
function correctionContext(cfg, verdict = 'correct') {
  const opening = verdict === 'mixed'
    ? 'ENGLISH-COACH: this prompt is mostly not in English, and mixed_mode is set to `correct`. Correct whatever English fragments it does contain; if there are none worth a correction, say nothing about English at all. Do the requested work first and in full.'
    : 'ENGLISH-COACH: this prompt is in English. Do the requested work first and in full — the correction goes at the very end and never delays or replaces the work.';
  const lines = [
    opening,
    `Strictness: ${STRICTNESS[cfg.strictness]}`,
    `At most ${cfg.max_items} item(s). Fewer is better; nothing worth saying means say nothing.`,
    `Format per item: "✗ <original> / ✓ <natural> / <one-line rule>" with the rule written in ${cfg.explain_lang === 'ko' ? 'Korean' : 'English'}.`,
    'Neutralise before recording: replace product, company, system and person names, issue numbers and keys with X / the service / the job. The grammar pattern is the asset; the domain noun is not.',
    `Tag every item with a category from: ${CATEGORIES.join(', ')}. Join multiple with "+". An untagged item is unusable later, so a category is mandatory.`,
    `Routing: ${OUTPUT[cfg.output]}`,
  ];
  if (cfg.focus.length) lines.push(`Focus: report only these categories — ${cfg.focus.join(', ')}. Ignore everything else.`);
  const led = ledgerInstruction(cfg, 'correct');
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
    const src = s[k] || 'default';
    lines.push(`  ${k.padEnd(16)} ${String(show(cfg[k])).padEnd(42)} [${src}]${src === 'default' ? '' : ` default=${show(DEFAULTS[k])}`}`);
  }
  // An env var that failed validation is thrown away by load(). Saying nothing
  // about it leaves the user looking at a value they did not set, with no way
  // to learn their variable was rejected.
  for (const [name, why] of cfg._rejected || []) {
    lines.push(`  !! ${name} was REJECTED and ignored — ${why}`);
  }
  // Say what the file is doing, not just where it lives. Printing a bare path
  // for a file that does not exist invites the reader to assume it does.
  const f = cfg._file || {};
  const applied = KEYS.filter(k => s[k] === 'file').length;
  const shadowed = KEYS.filter(k => s[k] === 'env' && f.keys && f.keys.includes(k)).length;
  const state = f.missing ? 'not created yet — a /english-coach <key> <value> writes it'
    : f.invalid ? 'PRESENT BUT UNPARSEABLE — everything below fell back to env/default'
    : `${applied} key(s) applied${shadowed ? `, ${shadowed} more shadowed by env` : ''}`;
  lines.push('', `config file: ${configPath()} (${state})`, 'resolution: env ENGLISH_COACH_<KEY> > config file > default',
    'change: /english-coach <key> <value>   ·   tally: /english-coach stats [category]');
  return lines.join('\n');
}

// `--recent N` has to be pulled out before anything positional is read, or the
// flag's own argument reads as a category name.
function parseStatsArgs(rest) {
  let recent = null;
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--recent') {
      const raw = rest[i + 1];
      i += 1;
      const n = Number(raw);
      // NaN is falsy, so an unvalidated value here silently prints the whole
      // history under a heading that promised a window.
      if (raw === undefined || !Number.isInteger(n) || n < 1) {
        return { error: `--recent needs a positive whole number of days (got ${raw === undefined ? 'nothing' : `'${raw}'`})` };
      }
      recent = n;
    } else {
      positional.push(rest[i]);
    }
  }
  return { recent, cat: positional[0] || null };
}

function handleCommand(cfg, args) {
  const [rawHead, ...rest] = args;
  const head = (rawHead || '').toLowerCase();

  if (!head || head === 'status') return statusText(cfg);

  if (head === 'stats') {
    const { recent, cat, error } = parseStatsArgs(rest);
    if (error) return `ENGLISH-COACH: ${error}. Tell the user; nothing was read.`;
    const { items, exists, broken } = loadLedger(cfg.log_path);
    const title = exists ? `ENGLISH-COACH STATS — ${cfg.log_path}` : `ENGLISH-COACH STATS — no ledger yet at ${cfg.log_path}`;
    const warn = broken ? `\n(${broken} unparseable line(s) skipped)` : '';
    return `${title}${warn}\n\n${stats(items, { cat: cat ? cat.toLowerCase() : null, recent })}\n\nReport this to the user verbatim.`;
  }

  // `/english-coach on` and `/english-coach off` are shorthand for the enabled
  // key — the kill switch has to be the shortest thing to type.
  const isToggle = head === 'on' || head === 'off';
  const key = isToggle ? 'enabled' : head;
  // Only the key is case-folded. Values keep their case and their spaces: a
  // lowercased log_path points at a directory that does not exist on a
  // case-sensitive filesystem, and the ledger then stops silently — the exact
  // failure this plugin exists to catch. coerce() lowercases enum values itself.
  const value = isToggle ? head : rest.join(' ');

  if (!KEYS.includes(key)) {
    return `ENGLISH-COACH: unknown key '${key}'. Valid keys: ${KEYS.join(', ')}. Tell the user.`;
  }
  if (!value) {
    const allowed = ENUMS[key] ? ` (${ENUMS[key].join('|')})` : '';
    return `ENGLISH-COACH: ${key} = ${show(cfg[key])}${allowed}. Usage: /english-coach ${key} <value>. Tell the user.`;
  }

  let r;
  try {
    r = set(key, value);
  } catch (e) {
    // A write can fail on a read-only home, a full disk, or a bad
    // XDG_CONFIG_HOME. Falling through to the outer catch would emit nothing,
    // and the command file tells the model that no output means the hooks are
    // not running — reporting a disk error as a broken install.
    return `ENGLISH-COACH: could not write ${configPath()} — ${e.message}. Nothing was changed. Tell the user this is a filesystem problem, not a broken install.`;
  }
  if (!r.ok) return `ENGLISH-COACH: rejected — ${r.why}. Tell the user; nothing was changed.`;
  const shadow = r.shadowed ? ` WARNING: ${r.shadowed} is set in the environment and still overrides it.` : '';
  const replaced = r.replacedUnreadable ? ' NOTE: the existing config file was unreadable and has been replaced, so any settings it held are gone.' : '';
  return `ENGLISH-COACH: ${key} = ${show(r.value)}, saved to ${r.path}.${shadow}${replaced} Tell the user, then carry on with whatever else they asked.`;
}

// The CLI exposes a plugin command as /<plugin>:<command> and, when the command
// name starts with the plugin name, a bare alias too. Spell every accepted form
// out: an optional `-coach` suffix plus \b also matches /english-teacher,
// because \b is satisfied by the hyphen once the optional group backtracks.
const COMMAND = /^\/(?:english-coach:english-coach|english-coach:english|english-coach|english)(?=\s|$)\s*(.*)$/is;

function run(raw) {
  let prompt = '';
  try {
    prompt = String(JSON.parse(String(raw).replace(/^\uFEFF/, '')).prompt || '');
  } catch (e) {
    return; // malformed stdin: stay out of the way
  }

  const cfg = loadConfig();

  // Commands are handled even when disabled, or `/english-coach on` could not reach us.
  const cmd = prompt.trim().match(COMMAND);
  if (cmd) {
    const args = cmd[1].trim().split(/\s+/).filter(Boolean);
    return emit(handleCommand(cfg, args));
  }

  if (cfg.enabled === 'off') return;

  const { verdict } = classify(prompt, cfg);
  if (verdict === 'correct') return emit(correctionContext(cfg));
  if (verdict === 'mixed') {
    if (cfg.mixed_mode === 'translate') return emit(translateContext(cfg));
    if (cfg.mixed_mode === 'correct') return emit(correctionContext(cfg, 'mixed'));
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
// Decode as UTF-8 across chunk boundaries. Without this each Buffer is
// stringified on its own, so a Hangul syllable split across two pipe writes
// becomes U+FFFD and the Korean character count — which decides `mixed` — is
// off by one.
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', finish);
// Never hang a session waiting on stdin that will not close. unref() keeps the
// timer off the normal path, where 'end' fires first.
process.stdin.on('error', () => { finish(); process.exit(0); });
setTimeout(() => { finish(); process.exit(0); }, 1000).unref();
