# english-coach

A Claude Code plugin for people who write prompts in a second language.

You write a prompt in English. The work happens exactly as it would have anyway,
and at the end of the answer you get the two or three things you'd have written
differently. Each one is logged as a neutralised minimal pair, so after a month
you can see *which mistakes you actually repeat* instead of guessing.

And when the log goes quiet, it tells you.

## The part that matters

Correction rules usually live as a line of prose in a config file: *"if I write
in English, correct me at the end."* That line has no enforcer and no watchdog.
It runs when the model happens to remember it.

The version of this that preceded the plugin stopped running for **34 days** and
nobody noticed — not because the gap was acceptable, but because nothing was
watching. It surfaced only when someone manually ran a tally for an unrelated
reason.

So this plugin ships the watchdog as the point, not a feature:

- `SessionStart` reads the ledger and, if the newest entry is older than
  `gap_alert_days`, says so in your first reply of the session.
- `UserPromptSubmit` runs a deterministic gate and injects the correction
  contract only when it fires.

A rule that can stop silently will stop silently.

## Install

```bash
/plugin marketplace add haung921209/english-coach
/plugin install english-coach@english-coach
```

Requires `node` (any version Claude Code itself runs on). **Zero dependencies**,
nothing to build, no network access at runtime.

## What fires, and when

The gate is pure counting — no model call, no heuristic that drifts day to day.
The hook never decides *how* to correct, only whether it's worth the noise. The
correcting is done by the model that's already reading your prompt.

1. Strip what isn't English: fenced and inline code, URLs, path-shaped tokens,
   `@mentions`, `#1234`, `/commands`.
2. Count Hangul characters, Latin words, and the Latin character ratio.
3. `en_words >= min_en_words` **and** `ratio >= min_en_ratio` → **correct**
4. `ko_chars >= mixed_min_chars` **and** `ratio < min_en_ratio` → **mixed**
5. otherwise → **skip** (silence)

| prompt | words | ratio | verdict |
|---|---|---|---|
| a long English prompt | 39 | 1.00 | `correct` |
| a long Korean prompt | 0 | 0.00 | `mixed` |
| `ok run it` | 3 | 1.00 | `skip` — too short |
| `the job 에서 replicate 돌려주고 결과 보여줘` | 3 | 0.58 | `skip` — English nouns in Korean |
| a code block only | 0 | 0.00 | `skip` |
| `check ~/some/path/file.py and the log` | 4 | 1.00 | `skip` — mostly a path |

Being deterministic is the point: the same prompt always lands the same way, and
every threshold in that table is a number you can move.

> **Known weak spot.** Row 4 clears the `0.6` threshold by `0.02`. Korean
> prompts sprinkled with English technical nouns crowd that band, so
> `min_en_ratio` is the most sensitive knob here. If you get false positives,
> try a stopword list for technical nouns before raising the threshold —
> raising it starts dropping real English.

### `mixed` is what makes this run daily

If it only fired on `correct`, it would almost never fire — most people's
prompts are mostly in their first language. `mixed_mode: translate` takes a
Korean prompt and shows **one sentence** of the English you'd have written. That
sentence never had a chance to be wrong, which is exactly why it's worth seeing.

## Settings

Resolution order: **environment variable → config file → default.**

- Environment: `ENGLISH_COACH_<KEY>`, e.g. `ENGLISH_COACH_STRICTNESS=loose`.
- File: `$XDG_CONFIG_HOME/english-coach/config.json`, falling back to
  `~/.config/english-coach/config.json` (`%APPDATA%\english-coach\` on Windows).
- In a session: `/english <key> <value>` — writes the file.

| key | values | default | what changes |
|---|---|---|---|
| `enabled` | `on` `off` | `on` | both hooks |
| `strictness` | `strict` `normal` `loose` | `normal` | see below |
| `output` | `inline` `file` `both` | `both` | where corrections go |
| `max_items` | 1–5 | `3` | ceiling per answer |
| `explain_lang` | `ko` `en` | `ko` | language of the rule line |
| `log_path` | path | `<config dir>/log.jsonl` | where the ledger lives |
| `focus` | category list | `[]` (all) | report only these |
| `gap_alert_days` | `0` = off, else N | `7` | stale-ledger warning |
| `min_en_words` | integer | `8` | below this, skip |
| `min_en_ratio` | 0–1 | `0.6` | below this, not English |
| `mixed_min_chars` | integer | `40` | Korean this long → `mixed` |
| `mixed_mode` | `off` `translate` `correct` | `translate` | what `mixed` does |

**`off` is not negotiable.** A hook you can't turn off gets deleted instead of
disabled — and then the 34-day gap comes straight back, permanently.

### `strictness`

| | catches | leaves alone |
|---|---|---|
| `strict` | errors + awkwardness + **better-phrasing suggestions** | — |
| `normal` | meaning wobbles, clearly unnatural | upgrades to phrasing that works |
| `loose` | only what misleads or doesn't land | article and preposition friction |

`strict`'s suggestion axis is separate from error correction — it fires on
sentences with nothing wrong that a native speaker still wouldn't write.

### `output`

`inline` shows corrections and writes nothing. `file` writes the ledger and says
nothing in the answer, so you run your own review loop on your own schedule.
`both` does both.

Because `inline` never writes, the gap alert is **suppressed** under `inline` —
warning about a ledger you told it not to write would just train you to ignore
the warning.

## The ledger

Append-only JSONL at `log_path`. Two `kind`s:

```json
{"schemaVersion":"english.pattern.v1","date":"2026-01-31","kind":"correct","cat":"modal+register","wrong":"is it possible that promote works?","right":"can promote work?","rule":"가능성은 can/would 로","note":""}
{"schemaVersion":"english.pattern.v1","date":"2026-01-31","kind":"translate","cat":"question-form","wrong":"","right":"Can you run the job and show me the result?","rule":"요청은 Can you 로 연다","note":""}
```

- `kind` is `correct` or `translate`; **absent means `correct`**, so a v1 ledger
  written before `kind` existed reads back unchanged.
- `translate` entries leave `wrong` empty — there was no wrong version.
- `cat` comes from the fourteen categories in the skill; join several with `+`.
- `wrong` / `right` are **neutralised** minimal pairs. Product and system names,
  issue numbers, keys and paths are replaced with `X` / `the service` / `the
  job` before anything is written. The grammar pattern is the asset; the domain
  noun is not.

### Your data stays yours

The plugin ships **code only**. The ledger and config are written under your
home directory, never into the repository, and nothing is ever sent anywhere.
A fresh install starts at zero entries.

### Reading it

```bash
/english stats                  # category frequency, most-missed first
/english stats modal            # the minimal pairs in one category
node hooks/ledger.js --recent 30    # same tally, straight from a shell
```

Drill the top two or three categories. Trying to cover all fourteen evenly
leaves you with nothing.

## Commands

| | |
|---|---|
| `/english` or `/english status` | every setting, its value, and where it came from |
| `/english stats [category]` | the tally |
| `/english <key> <value>` | change a setting, persisted to the config file |
| `/english on` / `/english off` | the kill switch |

Rejected values say why and change nothing. If an environment variable is
shadowing the key you just set, it tells you that too.

## Not in scope

- **Scoring, levels, grades.** Deliberately excluded — this is a pattern log,
  not an assessment, and turning it into one changes what you write.
- **Storing original prompts.** Neutralised minimal pairs only.
- **First-language style.** A different problem; keep it in a different tool.

## Layout

```
.claude-plugin/plugin.json       manifest
.claude-plugin/marketplace.json  marketplace entry
hooks/hooks.json                 wiring
hooks/session-start.js           contract + settings + gap alert
hooks/prompt-submit.js           gate + /english commands
hooks/detect.js                  the gate (pure counting)
hooks/config.js                  env → file → default
hooks/ledger.js                  read, gap, tally (also a CLI)
hooks/test.js                    self-check
skills/english-coach/SKILL.md    the correction contract
commands/english.md              /english
```

```bash
node hooks/test.js    # or: npm test
```

## License

MIT
