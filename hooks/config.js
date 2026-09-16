#!/usr/bin/env node
// english-coach — configuration resolver.
//
// Resolution order (highest first):
//   1. ENGLISH_COACH_<KEY> environment variable
//   2. $XDG_CONFIG_HOME/english-coach/config.json
//      (~/.config/english-coach/config.json on macOS/Linux,
//       %APPDATA%\english-coach\config.json on Windows)
//   3. DEFAULTS below
//
// Defaults are a suggestion, not a contract. Every key is settable with
// `/english <key> <value>`, which writes the config file.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  enabled: 'on',            // on | off  — off silences both hooks
  strictness: 'normal',     // strict | normal | loose
  output: 'both',           // inline | file | both
  max_items: 3,             // 1-5, ceiling on corrections per answer
  explain_lang: 'ko',       // ko | en  — language of the rule line
  log_path: '',             // '' resolves to <config dir>/log.jsonl
  focus: [],                // [] = all categories, else a subset
  gap_alert_days: 7,        // 0 = off, else warn when the ledger is N days stale
  min_en_words: 8,          // fewer Latin words than this -> skip
  min_en_ratio: 0.6,        // Latin-char ratio below this -> not English
  mixed_min_chars: 40,      // Korean-dominant but at least this long -> mixed
  mixed_mode: 'translate',  // off | translate | correct
};

const ENUMS = {
  enabled: ['on', 'off'],
  strictness: ['strict', 'normal', 'loose'],
  output: ['inline', 'file', 'both'],
  explain_lang: ['ko', 'en'],
  mixed_mode: ['off', 'translate', 'correct'],
};

const CATEGORIES = [
  'article', 'countability', 'tense', 'aspect', 'modal', 'preposition',
  'word-order', 'connector', 'register', 'verbosity', 'word-choice',
  'agreement', 'conditional', 'question-form',
];

const KEYS = Object.keys(DEFAULTS);

function configDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'english-coach');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'english-coach'
    );
  }
  return path.join(os.homedir(), '.config', 'english-coach');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Coerce one raw value (env string, JSON value, or /english argument) to the
// type its key expects. Returns {ok, value} | {ok:false, why}.
function coerce(key, raw) {
  if (!KEYS.includes(key)) {
    return { ok: false, why: `unknown key '${key}' (valid: ${KEYS.join(', ')})` };
  }
  if (ENUMS[key]) {
    const v = String(raw).trim().toLowerCase();
    if (!ENUMS[key].includes(v)) {
      return { ok: false, why: `${key} must be one of ${ENUMS[key].join('|')}` };
    }
    return { ok: true, value: v };
  }
  if (key === 'focus') {
    let list;
    if (Array.isArray(raw)) list = raw;
    else {
      const s = String(raw).trim();
      list = (s === '' || s === 'none' || s === '[]') ? [] : s.split(/[,\s]+/);
    }
    list = list.map(c => String(c).trim().toLowerCase()).filter(Boolean);
    const bad = list.filter(c => !CATEGORIES.includes(c));
    if (bad.length) {
      return { ok: false, why: `unknown categor${bad.length > 1 ? 'ies' : 'y'}: ${bad.join(', ')}` };
    }
    return { ok: true, value: list };
  }
  if (key === 'log_path') {
    const v = String(raw).trim();
    return v ? { ok: true, value: v } : { ok: false, why: 'log_path must not be empty' };
  }
  if (key === 'min_en_ratio') {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, why: 'min_en_ratio must be a number between 0 and 1' };
    }
    return { ok: true, value: v };
  }
  // remaining keys are integers
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    return { ok: false, why: `${key} must be a non-negative integer` };
  }
  if (key === 'max_items' && (v < 1 || v > 5)) {
    return { ok: false, why: 'max_items must be between 1 and 5' };
  }
  return { ok: true, value: v };
}

function envName(key) {
  return 'ENGLISH_COACH_' + key.toUpperCase();
}

function readFileConfig() {
  try {
    // Strip a UTF-8 BOM; editors on Windows add one and JSON.parse chokes on it.
    const raw = fs.readFileSync(configPath(), 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Resolved config plus, for `/english status`, where each value came from.
function load() {
  const fileCfg = readFileConfig();
  const cfg = { ...DEFAULTS };
  const source = {};
  for (const key of KEYS) {
    source[key] = 'default';
    if (Object.prototype.hasOwnProperty.call(fileCfg, key)) {
      const r = coerce(key, fileCfg[key]);
      if (r.ok) { cfg[key] = r.value; source[key] = 'file'; }
    }
    const env = process.env[envName(key)];
    if (env !== undefined && env !== '') {
      const r = coerce(key, env);
      if (r.ok) { cfg[key] = r.value; source[key] = 'env'; }
    }
  }
  cfg.log_path = expandHome(cfg.log_path) || path.join(configDir(), 'log.jsonl');
  cfg._source = source;
  return cfg;
}

function set(key, raw) {
  const r = coerce(key, raw);
  if (!r.ok) return r;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = readFileConfig();
  cfg[key] = r.value;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  // An env var of the same name still wins on the next read — say so, or the
  // user watches a setting "not take" with no explanation.
  const shadowed = process.env[envName(key)] !== undefined && process.env[envName(key)] !== '';
  return { ok: true, value: r.value, path: p, shadowed: shadowed ? envName(key) : null };
}

module.exports = { DEFAULTS, ENUMS, CATEGORIES, KEYS, configDir, configPath, coerce, envName, expandHome, load, set };
