# dsh-subagent-tiering

Subagents run on a cheaper sibling of the parent's model unless the main agent
names a route itself.

## Install

```bash
dsh plugin --profile web add github:lucagiftzek/dsh-subagent-tiering
# then restart `dsh web`
```

The package declares `dsh.bundle`, so `dsh plugin add` lists it in `dsh.profile.bundles` and
its own patch inserts the `subagent-tiering` entry with the built-in rules. A local checkout
works too: `dsh plugin --profile web add link:/absolute/path/to/dsh-subagent-tiering`.
Requires Node 22.18 or newer; used on DSH 0.1.5 and 0.2.1. Read "Needs" below: without a
subagent model-selection policy the plugin changes nothing.

| Parent route | Child default |
|---|---|
| anthropic Opus / Fable / Sonnet | anthropic `claude-sonnet-5-5` @ medium (falls back to `claude-sonnet-5`) |
| alibaba Qwen max/plus | `qwen3.8-flash` @ high |
| alibaba / byteplus DeepSeek pro | the provider's DeepSeek flash @ high |
| byteplus GLM / Seed | `glm-5-3-flash-260828` @ high |
| deepseek-official | `deepseek-flash` @ high |
| mistral large | `mistral-medium-latest` |
| any other mistral, alibaba GLM, hetzner | same model, effort capped at high (never raised) |
| anything else | inherits the parent, as stock dsh does |

`vision-toolkit-<x>` parents keep their wrapper provider. Rules live in
`src/rules.js` and can be overridden with a `- id: subagent-tiering` row in the
profile's `cordis.patch.yml` (`config.rules`, same shape).

A rule's `child.fallbackModels` (optional list of model ids, same provider and
effort) is tried in order when the primary model is not in the chat's captured
allow-list or does not resolve. 2026-09-29: the Anthropic default moved from
Sonnet 5 to Sonnet 5.5; chats created before that day have no Sonnet 5.5 in
their allow-list, so they keep getting Sonnet 5 instead of inheriting Opus.

## Why (2026-09-27)

Over 14 days of session logs on one busy install, 70% of dsh's Anthropic calls were
subagents. The stock `ptc` preset gives `subagent` no child defaults, so every
child ran on the parent's route and effort (usually Opus 5.5 at max). Per human
prompt, dsh cost 2.1x what Claude Code did on the same box, while per call the
two were about equal. `tool-subagent`'s own `agentOptions` is one static route
and cannot express "Opus parent → Sonnet child, Qwen parent → Qwen-flash child".

## How it works

A `tools/pre-execute` handler. When a `subagent` call names no `provider`,
`model` or `reasoning_effort`, it fills them in from the first matching rule, as
if the model had asked. The stock tool then runs its normal checks. It leaves the
call untouched, so the child inherits the parent, when:

- the main agent passed any of the three fields itself (its choice always wins);
- the chat has no model-selection policy. dsh records one only for chats created
  while `subagent-model-selection.enabled` is true, so chats that predate
  2026-09-27 are not affected;
- the target route is not in that policy's `allowedModels`;
- `llm.resolveCallConfig` rejects the route. If it rejects only the effort, the
  effort is dropped and the route kept;
- core dsh ever freezes the execution record. This is logged once.

`subagent_fork` is never touched. A fork must stay on the parent route to reuse
its cached prefix.

A short system-prompt section (`subagent-tiering`, about 90 tokens) tells the
model about the default and how to override it.

### Trade-off

A child on a different model cannot reuse the parent's prompt cache, so its
first call pays a full cache write (about 48k tokens on Anthropic after the GenUI
removal). A one-call subagent can therefore cost slightly more than before. The
median subagent here makes 28 calls, so it comes out well ahead.

## Needs

- settings `subagent-model-selection: { enabled: true, allowedModels: [...] }`.
  On DSH 0.2.x this harness setting lives under the entry
  `subagent-model-selection-settings` and is not imported from an old `settings.yaml`
  (see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#t-after-update)).
- the `ptc` / `ptc-lean` preset's `tool-subagent` row with
  `modelSelectionSettings: true` (stock).
- adaptive-reasoning must NOT list `anthropic/claude-sonnet-5-5` (or
  `claude-sonnet-5`, the fallback) among its routes,
  or it would override the child's medium effort on every step.

## Verify

`node --test test/*.test.js` runs the unit tests. End to end: start a new chat on
Opus 5.5 and have it call `subagent` with no model. The child session's
`request/header` shows `claude-sonnet-5-5` / `medium` (was `claude-sonnet-5`
until 2026-09-29). Checked on 2026-09-27 on
a production install (Opus → Sonnet) and in a sandbox (Qwen max → Qwen flash; an explicit
`qwen3.8-max @ low` was left as asked).

## When something goes wrong

- Ask your agent to load the **`subagent-tiering-doctor`** skill (copy
  `skills/subagent-tiering-doctor` into `~/.dsh/skills/` once,
  [how](docs/TROUBLESHOOTING.md#skill)).
- Symptom-first guide: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
- Log lines and start-up messages: [docs/ERRORS.md](docs/ERRORS.md).

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If this plugin is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.
