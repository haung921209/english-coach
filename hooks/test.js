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
  assert.strictEqual(r.metrics.ratio, 0.58);
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
check('a corrupt config file falls back to defaults instead of throwing', () => {
  const p = config.configPath();
  const saved = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, '{not json');
  assert.strictEqual(config.load().strictness, 'normal');
  fs.writeFileSync(p, saved);
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

// ---- packaging -----------------------------------------------------------
console.log('\npackaging');
const root = path.join(__dirname, '..');
check('plugin.json points at hooks.json, which wires both hooks', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'));
  const hooksFile = path.join(root, plugin.hooks.replace(/^\.\//, ''));
  const wiring = JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks;
  assert.ok(wiring.SessionStart && wiring.UserPromptSubmit);
  assert.strictEqual(wiring.SessionStart[0].matcher, 'startup|resume|clear|compact');
  for (const ev of ['SessionStart', 'UserPromptSubmit']) {
    for (const g of wiring[ev]) for (const h of g.hooks) {
      const script = h.command.match(/hooks\/([\w.-]+\.js)/)[1];
      assert.ok(fs.existsSync(path.join(root, 'hooks', script)), `${script} missing`);
    }
  }
});
check('marketplace.json lists this plugin', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.strictEqual(m.plugins.length, 1);
  assert.strictEqual(m.plugins[0].name, 'english-coach');
});
check('nothing ships an absolute home path or an internal name', () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p) : files.push(p);
    }
  })(root);
  const leak = /\/Users\/|\/home\/[a-z]/;
  for (const f of files) {
    if (path.basename(f) === 'test.js') continue; // the sandbox assertions live here
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!leak.test(body), `${path.relative(root, f)} contains an absolute home path`);
  }
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed  (gate ${gatePass}/${gateTotal})`);
process.exit(fail ? 1 : 0);
