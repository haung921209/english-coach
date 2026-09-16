---
name: english-coach
description: The correction contract for English written in prompts. Use when the english-coach hook says a prompt is English (or Korean worth rehearsing in English), or when the user asks about their English patterns, the correction ledger, or /english settings.
---

# english-coach

The hook decides *whether* to correct. You do the correcting. This file is the
contract for how.

## Three rules, in priority order

1. **Never block the work.** Do what the user asked, in full, first. The
   correction goes at the very end of your answer. Putting it first pushes the
   work back, and a language tool that costs you time gets uninstalled.
2. **Never store the original prompt.** Work prompts carry system names, issue
   numbers, keys and spec values. Record only a *neutralised minimal pair*. The
   grammar pattern is the asset; the domain noun is not. See Neutralising.
3. **Always tag a category.** Frequency counting is the whole reason the ledger
   exists. An untagged entry cannot be drilled later, so it is worthless.

## Categories

Pick from this list. Join several with `+` (`article+countability`).

| cat | what |
|---|---|
| `article` | a / an / the / no article |
| `countability` | count vs mass nouns, plurals |
| `tense` | tense choice |
| `aspect` | perfect and progressive |
| `modal` | can / could / would / should / might |
| `preposition` | prepositions |
| `word-order` | ordering, modifier placement |
| `connector` | however / so / while, transitions |
| `register` | too formal, too colloquial |
| `verbosity` | long where short would do |
| `word-choice` | understandable but not what a native speaker picks |
| `agreement` | number and person agreement |
| `conditional` | conditional forms |
| `question-form` | question construction |

Nothing fits? Use the closest one and say why in `note`. Do not invent a
category — an unbounded vocabulary makes the tally meaningless.

## Strictness

Set with `/english strictness <value>`; the hook tells you the active level.

| | catches | leaves alone |
|---|---|---|
| `strict` | errors + awkwardness + **better-phrasing suggestions** | — |
| `normal` | meaning wobbles, clearly unnatural | upgrades to phrasing that already works |
| `loose` | only what misleads or does not land | article and preposition friction |

`strict`'s better-phrasing axis is **not** error correction. It fires on
sentences with nothing wrong: correct, understood, but not what a native speaker
would write. Label those so they are not mistaken for mistakes.

## Output routing

| `output` | in the answer | in the ledger |
|---|---|---|
| `inline` | yes | no |
| `file` | no — stay silent | yes |
| `both` (default) | yes | yes |

`file` exists so the user can run their own review loop without the corrections
cluttering every answer. When it is set, say nothing about English at all.

## Format

At most `max_items` entries (default 3). Fewer is better. Nothing worth saying
means say nothing — a padded correction teaches the user to skip the section.

```
—— english ——
✗ is it possible that promote works?
✓ can promote work? / would promote work?
  가능성은 can/would 로. 'is it possible that' 은 격식체이고 장황하다.
```

- `✗` the neutralised original, `✓` the natural version, then **one line** on the
  rule.
- The rule line says *what to do next time*, not what went wrong. `explain_lang`
  picks its language (`ko` default, `en` available).
- For a `strict` better-phrasing item, mark it: `✓ (더 자연스럽게)` / `(more natural)`.
- If `focus` is set, report only those categories and drop the rest silently.

### The `translate` variant

When the prompt was Korean and long enough, the hook asks for a rehearsal
instead: **one sentence** of the English the user would have written, plus one
line naming the phrasing choice worth keeping. There is no `✗` side — this
sentence never had a chance to be wrong, which is exactly why it is worth
showing.

```
—— english (영어로 썼다면) ——
→ Can you run the replication job and show me the result?
  요청은 'Can you ...?' 로 여는 게 'Is it possible to ...' 보다 짧고 자연스럽다.
```

## Neutralising

Before anything reaches the ledger, replace:

| kind | becomes |
|---|---|
| product, company, service, system names | `X`, `the service` |
| job, pipeline, task names | `the job` |
| people | `the reviewer`, `a teammate` |
| issue and ticket numbers, keys, tokens, IDs | drop them |
| absolute paths, hostnames, internal URLs | `the path`, `the host` |

If neutralising would destroy the grammar point, drop the entry. A lost entry
costs nothing; a leaked one cannot be unleaked.

## Writing the ledger

Append **one JSON object per line** to the `log_path` the hook gave you
(append-only; create the directory first if it is missing).

```json
{"schemaVersion":"english.pattern.v1","date":"2026-01-31","kind":"correct","cat":"modal+register","wrong":"is it possible that promote works?","right":"can promote work?","rule":"가능성은 can/would 로","note":""}
{"schemaVersion":"english.pattern.v1","date":"2026-01-31","kind":"translate","cat":"question-form","wrong":"","right":"Can you run the job and show me the result?","rule":"요청은 Can you 로 연다","note":""}
```

- `kind` — `correct` or `translate`. Absent means `correct`.
- `translate` entries leave `wrong` empty; `right` holds the English sentence.
- `note` — optional, only for exceptions that split within a category.
- Never rewrite or delete existing lines. Append only.

## Not this plugin's job

- **Scoring, levels, grades.** Deliberately excluded. This is a pattern log, not
  an assessment.
- **Keeping original prompts.** Minimal pairs only.
- **Korean style.** A separate concern; do not fold it in here.
