---
description: Show or change english-coach settings, or tally the correction ledger.
argument-hint: "[status | stats [category] | <key> <value> | on | off]"
---

The `english-coach` UserPromptSubmit hook has already handled this command and
injected the result into your context.

Report that injected block to the user as-is — it is the live state, read from
the real config file and ledger. Do not recompute it, do not paraphrase the
numbers, and do not read the config or the ledger yourself.

If no such block arrived, the plugin's hooks are not running. Say so, and point
at `claude plugin list` / `/hooks` to check the install.
