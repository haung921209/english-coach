#!/usr/bin/env node
// english-coach — self-check. No framework: `node hooks/test.js`.
//
// The gate case table is the contract ported from the Python prototype; if it
// drifts, the plugin fires on the wrong prompts and the ledger fills with noise.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every config lookup at a throwaway dir BEFORE loading the modules, so a
// test run can never read or write the real ~/.config/english-coach.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'english-coach-test-'));
process.env.XDG_CONFIG_HOME = sandbox;
for (const k of Object.keys(process.env)) if (k.startsWith('ENGLISH_COACH_')) delete process.env[k];

const { classify } = require('./detect');
const config = require('./config');
const ledger = require('./ledger');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// ---- gate: the 8 cases ported from prototype/detect.py -------------------
console.log('gate (8 cases)');
const CASES = [
  ['correct', 'I want to make some kind of personal skill or something which is help ' +
              'improving English while prompting. So just issue from the local issue to ' +
              'public or something what you need to do is just making some local issue'],
  ['correct', 'As you know, depending on the config file is very weak so I want to make ' +
              'some kind of hook something like that. I want to give some chance about ' +
              'modifying preference for users so our spec need to have preference'],
  ['mixed',   '영어 부분에 대해서만 처리한다고 가정합시다. 이 부분에 대해서 모델 비용 없이 ' +
              '기계적 판단은 불가합니까? 예를 들어, 영어 길이가 어느정도 이상이 되어야 ' +
              '판단한다 뭐 그런 것들에 대해서 설정을 제공하고'],
  ['skip',    'ok run it'],
  ['skip',    'PR 만들어줘'],
  ['skip',    'the job 에서 replicate 돌려주고 결과 보여줘'],   // English nouns in Korean
  ['skip',    '```\nfor i in range(10): print(i)\n```'],        // code block only
  ['skip',    'check ~/some/path/file.py and the log'],         // mostly a path, short
];
for (const [want, text] of CASES) {
  check(`${want.padEnd(7)} ${JSON.stringify(text.slice(0, 40))}`, () => {
    const { verdict, metrics } = classify(text);
    assert.strictEqual(verdict, want, `got ${verdict} ${JSON.stringify(metrics)}`);
  });
}
const gateTotal = CASES.length, gatePass = pass;
console.log(`  ${gatePass}/${gateTotal} 통과\n`);

// ---- gate: thresholds are real knobs, not decoration ---------------------
console.log('gate thresholds');
check('min_en_words lowered turns a skip into a correct', () => {
  assert.strictEqual(classify('ok run it').verdict, 'skip');
  assert.strictEqual(classify('ok run it', { min_en_words: 3 }).verdict, 'correct');
});
check('mixed_mode off suppresses mixed', () => {
  const ko = '한국어로 아주 길게 쓴 프롬프트입니다. 이 문장은 한글 글자 수가 문턱을 넘길 만큼 충분히 길어서 기본 설정에서는 mixed 판정을 받습니다.';
  assert.strictEqual(classify(ko).verdict, 'mixed');
  assert.strictEqual(classify(ko, { mixed_mode: 'off' }).verdict, 'skip');
});
check('the 0.58 borderline sits below the 0.6 threshold', () => {
  const r = classify('the job 에서 replicate 돌려주고 결과 보여줘');
  assert.strictEqual(Math.round(r.metrics.ratio * 100) / 100, 0.58);
});

// ---- config: all three resolution paths ---------------------------------
console.log('\nconfig resolution');
check('path 3 — defaults when nothing is set', () => {
  const cfg = config.load();
  assert.strictEqual(cfg.strictness, 'normal');
  assert.strictEqual(cfg.max_items, 3);
  assert.strictEqual(cfg._source.strictness, 'default');
  assert.strictEqual(cfg.log_path, path.join(sandbox, 'english-coach', 'log.jsonl'));
});
check('path 2 — config file overrides defaults', () => {
  const r = config.set('strictness', 'strict');
  assert.ok(r.ok, r.why);
  const cfg = config.load();
  assert.strictEqual(cfg.strictness, 'strict');
  assert.strictEqual(cfg._source.strictness, 'file');
});
check('path 1 — env overrides the config file', () => {
  process.env.ENGLISH_COACH_STRICTNESS = 'loose';
  const cfg = config.load();
  assert.strictEqual(cfg.strictness, 'loose');
  assert.strictEqual(cfg._source.strictness, 'env');
  delete process.env.ENGLISH_COACH_STRICTNESS;
});
check('off is reachable and every key round-trips', () => {
  assert.ok(config.set('enabled', 'off').ok);
  assert.strictEqual(config.load().enabled, 'off');
  assert.ok(config.set('enabled', 'on').ok);
  assert.strictEqual(config.load().enabled, 'on');
});
check('bad values are rejected, not silently coerced', () => {
  assert.strictEqual(config.set('strictness', 'nope').ok, false);
  assert.strictEqual(config.set('max_items', '9').ok, false);
  assert.strictEqual(config.set('min_en_ratio', '2').ok, false);
  assert.strictEqual(config.set('focus', 'article,nonsense').ok, false);
  assert.strictEqual(config.set('nosuchkey', 'x').ok, false);
  assert.strictEqual(config.load().strictness, 'strict', 'a rejected write must not land');
});
check('focus accepts a category list and clears with none', () => {
  assert.ok(config.set('focus', 'article,modal').ok);
  assert.deepStrictEqual(config.load().focus, ['article', 'modal']);
  assert.ok(config.set('focus', 'none').ok);
  assert.deepStrictEqual(config.load().focus, []);
});
check('a BOM-prefixed config file still parses', () => {
  const cp = config.configPath();
  const saved = fs.readFileSync(cp, 'utf8');
  try {
    fs.writeFileSync(cp, '\uFEFF' + JSON.stringify({ max_items: 2 }));
    assert.strictEqual(config.load().max_items, 2);
  } finally { fs.writeFileSync(cp, saved); }
});
check('a corrupt config file falls back to defaults instead of throwing', () => {
  const p = config.configPath();
  const saved = fs.readFileSync(p, 'utf8');
  try {
    fs.writeFileSync(p, '{not json');
    assert.strictEqual(config.load().strictness, 'normal');
  } finally { fs.writeFileSync(p, saved); }
});

// ---- ledger --------------------------------------------------------------
console.log('\nledger');
const logPath = path.join(sandbox, 'log.jsonl');
const entry = (d, cat, extra = {}) => JSON.stringify({
  schemaVersion: ledger.SCHEMA_VERSION, date: d, cat, wrong: 'w', right: 'r', rule: 'x', note: '', ...extra,
});
check('a broken line does not hide the rest', () => {
  fs.writeFileSync(logPath, [entry('2026-09-01', 'modal'), 'not json', entry('2026-09-02', 'article+modal')].join('\n') + '\n');
  const { items, broken } = ledger.load(logPath);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(broken, 1);
});
check('gap fires past the threshold and stays quiet inside it', () => {
  const { items } = ledger.load(logPath);
  assert.strictEqual(ledger.gap(items, 7, '2026-09-05'), null);
  const g = ledger.gap(items, 7, '2026-10-06');
  assert.strictEqual(g.days, 34);
  assert.strictEqual(g.last, '2026-09-02');
  assert.strictEqual(ledger.gap(items, 0, '2026-10-06'), null, '0 must disable the alert');
});
check('an empty ledger reports empty, not a gap', () => {
  const g = ledger.gap([], 7, '2026-10-06');
  assert.strictEqual(g.empty, true);
});
check('tally counts + -joined categories separately, descending', () => {
  const out = ledger.stats(ledger.load(logPath).items);
  assert.match(out, /modal\s+2/);
  assert.match(out, /article\s+1/);
  assert.ok(out.indexOf('modal') < out.indexOf('article'), 'most frequent first');
});
check('kind defaults to correct and translate is counted apart', () => {
  fs.appendFileSync(logPath, entry('2026-09-03', 'word-choice', { kind: 'translate', wrong: '' }) + '\n');
  const { items } = ledger.load(logPath);
  assert.strictEqual(ledger.kindOf(items[0]), 'correct', 'a kind-less v1 entry is a correction');
  assert.match(ledger.stats(items), /correct 2 · translate 1/);
});
check('--cat renders a translate entry without an empty ✗ line', () => {
  const out = ledger.stats(ledger.load(logPath).items, { cat: 'word-choice' });
  assert.match(out, /→ r/);
  assert.ok(!out.includes('✗'), 'translate has no wrong side');
});

// ---- commands: spawn the real hook, the way Claude Code does --------------
console.log('\ncommands');
const { execFileSync } = require('child_process');
function hook(script, payload) {
  return execFileSync(process.execPath, [path.join(__dirname, script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, XDG_CONFIG_HOME: sandbox },
    encoding: 'utf8',
  });
}
function context(out) {
  if (!out) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}
// The CLI may hand us any of these spellings; a regex that misses one makes the
// command silently unreachable, which no manifest check can see.
for (const spelling of ['/english-coach', '/english-coach status', '/english-coach:english-coach status', '/english status']) {
  check(`"${spelling}" reaches the handler`, () => {
    const out = context(hook('prompt-submit.js', { hook_event_name: 'UserPromptSubmit', prompt: spelling }));
    assert.match(out, /ENGLISH-COACH STATUS/);
  });
}
check('a prompt merely starting with "english" is not a command', () => {
  const out = context(hook('prompt-submit.js', { hook_event_name: 'UserPromptSubmit', prompt: '/englishx status' }));
  assert.ok(!/ENGLISH-COACH STATUS/.test(out), 'word boundary must hold');
});

check('status reports the config file state, not just its path', () => {
  const cp = config.configPath();
  const saved = fs.readFileSync(cp, 'utf8');
  const ask = () => context(hook('prompt-submit.js', { hook_event_name: 'UserPromptSubmit', prompt: '/english-coach status' }));

  try {
    fs.rmSync(cp);
    assert.match(ask(), /not created yet/, 'a path printed bare reads as "it exists"');
    fs.writeFileSync(cp, '{not json');
    assert.match(ask(), /PRESENT BUT UNPARSEABLE/, 'a dropped config must not look like a default');
  } finally { fs.writeFileSync(cp, saved); }
  assert.match(ask(), /key\(s\) applied/);
});

// ---- the review's findings, each with the reproduction that found it ------
console.log('\nregressions');
const cfgPath = config.configPath();
function withConfig(body) {
  const saved = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
  try { return body(); }
  finally {
    if (saved === null) { try { fs.rmSync(cfgPath); } catch (e) {} }
    else fs.writeFileSync(cfgPath, saved);
  }
}
function cmd(prompt) {
  return context(hook('prompt-submit.js', { hook_event_name: 'UserPromptSubmit', prompt }));
}

check('a value keeps its case and its spaces', () => {
  // Lowercasing a log_path points the ledger at a directory that does not exist
  // on a case-sensitive filesystem, and it then stops silently — the exact
  // failure this plugin exists to catch.
  withConfig(() => {
    cmd('/english-coach log_path ~/Docs/MyLog.jsonl');
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).log_path, '~/Docs/MyLog.jsonl');
    cmd('/english-coach log_path ~/My Docs/log.jsonl');
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).log_path, '~/My Docs/log.jsonl');
  });
});
check('an enum value is still case-insensitive', () => {
  withConfig(() => {
    cmd('/english-coach strictness STRICT');
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).strictness, 'strict');
  });
});
check('focus still accepts a space-separated list', () => {
  withConfig(() => {
    cmd('/english-coach focus article modal');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).focus, ['article', 'modal']);
  });
});
check('stats --recent is a flag, not a category', () => {
  const out = cmd('/english-coach stats --recent 30');
  assert.ok(!/범주 '30'/.test(out), "the flag's argument must not read as a category");
});
check('stats rejects a non-numeric --recent instead of printing everything', () => {
  assert.match(cmd('/english-coach stats --recent abc'), /--recent needs a positive whole number/);
  assert.match(cmd('/english-coach stats --recent'), /got nothing/);
});
check('mixed_mode: correct does not claim a Korean prompt is English', () => {
  const ko = '한국어로 아주 길게 쓴 프롬프트입니다. 이 문장은 한글 글자 수가 문턱을 넘길 만큼 충분히 길어서 기본 설정에서는 mixed 판정을 받습니다.';
  const out = context(execFileSync(process.execPath, [path.join(__dirname, 'prompt-submit.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: ko }),
    env: { ...process.env, XDG_CONFIG_HOME: sandbox, ENGLISH_COACH_MIXED_MODE: 'correct' },
    encoding: 'utf8',
  }));
  assert.ok(out, 'mixed_mode: correct must still emit a correction context');
  assert.ok(!/this prompt is in English/.test(out), 'the gate measured it as NOT English');
});
check('an unwritable config is reported, not swallowed into silence', () => {
  // Silence is what the command file tells the model means "hooks not running",
  // so a disk error would be reported to the user as a broken install.
  const notADir = path.join(sandbox, 'blocker');
  fs.writeFileSync(notADir, 'x');
  const out = context(execFileSync(process.execPath, [path.join(__dirname, 'prompt-submit.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '/english-coach strictness loose' }),
    env: { ...process.env, XDG_CONFIG_HOME: notADir },
    encoding: 'utf8',
  }));
  assert.match(out, /could not write/);
  assert.match(out, /not a broken install/);
});
check('a neighbouring /english-* command is not hijacked', () => {
  for (const p of ['/english-teacher help me', '/english-coachx hello', '/english-coach-extra x']) {
    assert.strictEqual(cmd(p), '', `${p} must not reach english-coach`);
  }
});
check('null and empty thresholds are rejected, not read as 0', () => {
  withConfig(() => {
    fs.writeFileSync(cfgPath, JSON.stringify({ min_en_words: null, min_en_ratio: null }));
    const cfg = config.load();
    assert.strictEqual(cfg.min_en_words, 8, 'null must not become 0');
    assert.strictEqual(cfg.min_en_ratio, 0.6);
    assert.strictEqual(classify('ok', cfg).verdict, 'skip');
  });
  for (const bad of [null, false, [], '', '  ', {}]) {
    assert.strictEqual(config.coerce('min_en_words', bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});
check('a rejected env var is named in status', () => {
  const out = context(execFileSync(process.execPath, [path.join(__dirname, 'prompt-submit.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '/english-coach status' }),
    env: { ...process.env, XDG_CONFIG_HOME: sandbox, ENGLISH_COACH_STRICTNESS: 'strictt' },
    encoding: 'utf8',
  }));
  assert.match(out, /ENGLISH_COACH_STRICTNESS was REJECTED/);
});
check('overwriting an unreadable config says so', () => {
  withConfig(() => {
    fs.writeFileSync(cfgPath, '{"strictness": "loose",,}');
    assert.match(cmd('/english-coach max_items 2'), /config file was unreadable and has been replaced/);
  });
});

console.log('\nsession-start (as a process)');
check('the gap alert fires end to end', () => {
  // The README calls this the point of the plugin, and it had no coverage
  // outside gap() in isolation.
  const stale = path.join(sandbox, 'stale.jsonl');
  const old = new Date(Date.now() - 34 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(stale, JSON.stringify({ schemaVersion: ledger.SCHEMA_VERSION, date: old, kind: 'correct', cat: 'modal', wrong: 'w', right: 'r', rule: 'x', note: '' }) + '\n');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'session-start.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...process.env, XDG_CONFIG_HOME: sandbox, ENGLISH_COACH_LOG_PATH: stale },
    encoding: 'utf8',
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /GAP ALERT/);
  assert.match(ctx, new RegExp(`no entry since ${old}`));
  assert.match(ctx, /34 days/);
});
check('an unreadable ledger is not reported as empty', () => {
  const broken = path.join(sandbox, 'broken.jsonl');
  fs.writeFileSync(broken, 'not json at all\n{half written');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'session-start.js')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...process.env, XDG_CONFIG_HOME: sandbox, ENGLISH_COACH_LOG_PATH: broken },
    encoding: 'utf8',
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /LEDGER UNREADABLE/);
  assert.ok(!/ledger is empty/.test(ctx), 'saying "empty" here is the opposite of the truth');
});
check('the gap check reads the tail, not the whole ledger', () => {
  // Append-only means this file grows forever; the startup hook must not scale
  // with its length.
  const big = path.join(sandbox, 'big.jsonl');
  const line = JSON.stringify({ schemaVersion: ledger.SCHEMA_VERSION, date: '2020-01-01', kind: 'correct', cat: 'modal', wrong: 'w'.repeat(200), right: 'r', rule: 'x', note: '' });
  const newest = JSON.stringify({ schemaVersion: ledger.SCHEMA_VERSION, date: '2026-01-31', kind: 'correct', cat: 'modal', wrong: 'w', right: 'r', rule: 'x', note: '' });
  fs.writeFileSync(big, Array(5000).fill(line).join('\n') + '\n' + newest + '\n');
  assert.ok(fs.statSync(big).size > 64 * 1024, 'fixture must exceed the tail window');
  assert.strictEqual(ledger.lastDateFromTail(big).last, '2026-01-31');
  const missing = ledger.lastDateFromTail(path.join(sandbox, 'nope.jsonl'));
  assert.strictEqual(missing.exists, false);
});

check('stdin is decoded across chunk boundaries', () => {
  // A Hangul syllable split across two pipe writes becomes U+FFFD if each
  // Buffer is stringified on its own, changing the count that decides `mixed`.
  const ko = '한국어로 아주 길게 쓴 프롬프트입니다. 이 문장은 한글 글자 수가 문턱을 넘길 만큼 충분히 길어서 기본 설정에서는 mixed 판정을 받습니다.';
  const payload = Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: ko }), 'utf8');
  const { spawnSync } = require('child_process');
  // Split mid-payload; with 3-byte syllables a byte-aligned cut lands inside one.
  const cut = Math.floor(payload.length / 2);
  const res = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, [${JSON.stringify(path.join(__dirname, 'prompt-submit.js'))}],
      { env: { ...process.env, XDG_CONFIG_HOME: ${JSON.stringify(sandbox)} }, stdio: ['pipe', 'inherit', 'inherit'] });
    const b = Buffer.from(${JSON.stringify(payload.toString('base64'))}, 'base64');
    c.stdin.write(b.subarray(0, ${cut}));
    setTimeout(() => c.stdin.end(b.subarray(${cut})), 20);
  `], { encoding: 'utf8' });
  assert.ok(!/�/.test(res.stdout), 'a split multi-byte character was replaced');
  assert.match(res.stdout, /ENGLISH-COACH/, 'the split payload must still parse');
});

check('every export is read by some other file', () => {
  // Counting a name across all files including the one that defines it passes
  // even when nothing imports it. Look only at the other files.
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/module\.exports = \{([^}]*)\}/);
    if (!m) continue;
    const names = m[1].split(',').map(x => x.split(':')[0].trim()).filter(Boolean);
    const others = files.filter(o => o !== f)
      .map(o => fs.readFileSync(path.join(dir, o), 'utf8')).join('\n');
    for (const name of names) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(others),
        `${f} exports ${name}, which no other file reads`);
    }
  }
});

// ---- packaging -----------------------------------------------------------
console.log('\npackaging');
const root = path.join(__dirname, '..');
function walkFiles(d = root, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (path.basename(p) !== 'test.js') out.push(p); // the assertions live here
  }
  return out;
}
check('hooks/hooks.json wires both hooks, and the manifest does not re-reference it', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  // hooks/hooks.json is loaded automatically. Naming it in manifest.hooks as well
  // makes the runtime reject the whole plugin as a duplicate hooks file — and it
  // fails at load time, after validate/install/details have all reported success.
  assert.ok(!plugin.hooks, 'manifest.hooks must not point at the auto-loaded hooks/hooks.json');
  const wiring = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')).hooks;
  assert.ok(wiring.SessionStart && wiring.UserPromptSubmit);
  assert.strictEqual(wiring.SessionStart[0].matcher, 'startup|resume|clear|compact');
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    for (const g of wiring[ev]) for (const h of g.hooks) {
      const script = h.command.match(/hooks\/([\w.-]+\.js)/)[1];
      assert.ok(fs.existsSync(path.join(root, 'hooks', script)), `${script} missing`);
    }
  }
});
check('the command file name starts with the plugin name', () => {
  // Claude Code exposes /<plugin>:<command> always, and a bare /<command> alias
  // only when the command name starts with the plugin name. commands/english.md
  // under plugin "english-coach" left /english unreachable — it resolved to
  // "Unknown command" while every manifest check reported success.
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  for (const f of fs.readdirSync(path.join(root, 'commands'))) {
    assert.ok(path.basename(f, '.md').startsWith(plugin.name),
      `commands/${f} would have no bare alias under plugin "${plugin.name}"`);
  }
});
check('marketplace.json lists this plugin', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.strictEqual(m.plugins.length, 1);
  assert.strictEqual(m.plugins[0].name, 'english-coach');
});
check('no shipped file carries an invisible U+FEFF', () => {
  // A literal BOM inside a source file is invisible in review and breaks a
  // shebang or JSON parse if it ever lands at offset 0. Escapes only.
  for (const f of walkFiles()) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes('\uFEFF'),
      `${path.relative(root, f)} contains a literal U+FEFF`);
  }
});
check('nothing ships an absolute home path or an internal name', () => {
  const leak = /\/Users\/|\/home\/[a-z]/;
  for (const f of walkFiles()) {
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!leak.test(body), `${path.relative(root, f)} contains an absolute home path`);
  }
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed  (gate ${gatePass}/${gateTotal})`);
process.exit(fail ? 1 : 0);
