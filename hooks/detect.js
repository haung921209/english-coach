#!/usr/bin/env node
// english-coach — the prompt gate. Pure counting, no model call.
//
// The hook does not correct anything; it only decides "is this worth
// correcting". The correction itself is done by the model that is already
// reading the prompt. Counting here is deterministic, so the same prompt always
// lands the same way and every threshold is a setting the user can move.
//
// Port of the Python prototype; the case table in test.js is the contract.

// Removed before counting — code, URLs, paths and mentions are not "English".
const NOISE = [
  /```[\s\S]*?```/g,                                 // fenced code
  /`[^`]*`/g,                                        // inline code
  /https?:\/\/\S+/g,                                 // URLs
  // Path-ish tokens. \p{L}\p{N} rather than \w so a path with non-ASCII
  // segments is stripped too — Python's \w is Unicode-aware, JS's is not.
  /[~./][\p{L}\p{N}_./-]*[/.][\p{L}\p{N}_./-]+/gu,
  /[@#/][\p{L}\p{N}_-]+/gu,                          // @mention, #1234, /command
];

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/g;
// Two characters minimum, matching the prototype: one-letter tokens ("I", "a")
// carry no pattern worth logging.
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]+/g;

function stripNoise(text) {
  let out = String(text || '');
  for (const pat of NOISE) out = out.replace(pat, ' ');
  return out;
}

// -> { verdict: 'correct'|'mixed'|'skip', metrics: {en_words, ko_chars, ratio} }
function classify(text, opt = {}) {
  const minWords = opt.min_en_words ?? 8;
  const minRatio = opt.min_en_ratio ?? 0.6;
  const mixedMinChars = opt.mixed_min_chars ?? 40;
  const mixedMode = opt.mixed_mode ?? 'translate';

  const body = stripNoise(text);
  const ko = (body.match(HANGUL) || []).length;
  const words = body.match(LATIN_WORD) || [];
  const en = words.reduce((n, w) => n + w.length, 0);
  const ratio = (en + ko) ? en / (en + ko) : 0;
  const metrics = { en_words: words.length, ko_chars: ko, ratio: Math.round(ratio * 100) / 100 };

  if (words.length >= minWords && ratio >= minRatio) return { verdict: 'correct', metrics };
  if (mixedMode !== 'off' && ko >= mixedMinChars && ratio < minRatio) {
    return { verdict: 'mixed', metrics };
  }
  return { verdict: 'skip', metrics };
}

module.exports = { classify, stripNoise };
