---
name: subagent-tiering-doctor
description: Diagnose dsh-subagent-tiering step by step. Load it when subagents keep running on the parent's expensive model, run on an unexpected model or effort, or when the user asks whether subagent tiering works.
---

# subagent-tiering doctor

dsh-subagent-tiering fills in a cheaper child route for `subagent` calls that name no
`provider`, `model` or `reasoning_effort`. When it cannot, the child inherits the parent and
the log says why. It has no routes, tools or UI.

## Rules
- Read-only checks first. Never restart `dsh web` yourself (your chat may run inside it).
- Settings and row edits are [HUMAN] steps: propose the exact YAML.
- Do not print `settings.yaml` or profile rows beyond the relevant lines; they can hold secrets.

## 0. Facts (read-only)
1. Plugin dir: `node -p "require('path').dirname(require.resolve('@lucagiftzek/dsh-subagent-tiering/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))"`
   Docs: `<plugin dir>/docs/TROUBLESHOOTING.md`, `docs/ERRORS.md`, built-in rules in `src/rules.js`.
2. `dsh --version` (0.1.x or 0.2.x matters for entry 7).
3. Log: `journalctl -u <your-dsh-unit> --since today | grep subagent-tiering | tail -20`
   (ask the human where DSH logs if it is not a systemd unit).
4. In the affected chat: the `list_subagent_models` tool shows the allowed routes.

## 1. Decision tree
- No `subagent-tiering: active` line since the last start:
  - a `subagent-tiering: ...` validation message -> ERRORS.md start-up table, propose the fix [HUMAN].
  - nothing at all -> not installed or not restarted: TROUBLESHOOTING C1 [HUMAN restart].
- `active`, and the call logged `inherit (...)`:
  - `model selection is off for this session` -> DSH 0.2.x? entry 7; else entry 1 cause 1.
    Either way the fix needs the human, then a NEW chat.
  - `... is not in the session's allowed routes` -> compare with fact 4; suggest a new chat
    after the route is added to the allow-list, or a fallback model the chat allows.
  - `... does not resolve` -> credentials or model id problem for that provider [HUMAN].
- `active`, no line at all for the call -> did the calling agent pass route fields? Then it is
  by design. Otherwise check `toolNames` in the row.
- Right model, wrong effort -> another per-step effort plugin lists the child route (entry 3) [HUMAN].
- Fallback model used instead of the primary -> chat predates the allow-list change (entry 2).
- Cost questions -> entry 5. `subagent_fork` not tiered -> by design (entry 6).

## 2. Report back
The relevant log line, the branch taken, and the exact change for the human (file, row, value),
including "start a new chat" when the fix only applies to new chats.
