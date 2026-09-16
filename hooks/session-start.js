#!/usr/bin/env node
// english-coach — SessionStart hook.
//
// Two jobs: say the plugin is on and what it is set to, and — the reason this
// hook is mandatory — shout when the ledger has gone quiet. A correction rule
// that silently stopped running is the failure this plugin exists to prevent.

const { load: loadConfig, configPath } = require('./config');
const { load: loadLedger, gap } = require('./ledger');

function emit(context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

function summary(cfg) {
  const s = cfg._source || {};
  const mark = k => (s[k] && s[k] !== 'default') ? `${cfg[k]}(${s[k]})` : cfg[k];
  return [
    `strictness=${mark('strictness')}`,
    `output=${mark('output')}`,
    `max_items=${mark('max_items')}`,
    `explain_lang=${mark('explain_lang')}`,
    `mixed_mode=${mark('mixed_mode')}`,
    `focus=${cfg.focus.length ? cfg.focus.join(',') : 'all'}`,
    `gap_alert_days=${mark('gap_alert_days')}`,
  ].join(' · ');
}

function main() {
  const cfg = loadConfig();
  if (cfg.enabled === 'off') return;

  const lines = [
    'ENGLISH-COACH ACTIVE — English prompts get a correction; work is never blocked.',
    `Settings: ${summary(cfg)}`,
    `Ledger: ${cfg.log_path} · config: ${configPath()}`,
  ];

  const { items, broken } = loadLedger(cfg.log_path);

  // `output: inline` never writes the ledger, so a gap there is expected, not
  // a defect — warning about it would train the user to ignore the warning.
  if (cfg.output !== 'inline') {
    const g = gap(items, cfg.gap_alert_days);
    if (g && g.empty) {
      lines.push(`NOTE: the ledger is empty. The first correction creates ${cfg.log_path}.`);
    } else if (g) {
      lines.push(
        `GAP ALERT: the ledger has no entry since ${g.last} — ${g.days} days ` +
        `(threshold ${cfg.gap_alert_days}). Either no English prompts happened, or ` +
        `corrections stopped being written. Tell the user this in your first reply; ` +
        `they asked to be told rather than find out months later. Silence with ` +
        `\`/english gap_alert_days 0\`.`
      );
    }
  }
  if (broken) lines.push(`NOTE: ${broken} unparseable ledger line(s) were skipped.`);

  lines.push(
    'When a correction is due the UserPromptSubmit hook says so explicitly. ' +
    'Follow the english-coach skill for the format. Never delay the actual work for it.'
  );

  emit(lines.join('\n'));
}

try { main(); } catch (e) { /* a hook must never break session start */ }
