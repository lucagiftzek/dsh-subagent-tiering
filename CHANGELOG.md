# Changelog

## 0.1.0 (2026-11-01)

First public release.

- `tools/pre-execute` handler: a `subagent` call that names no provider, model or effort gets the first matching rule's cheaper sibling route (Opus, Fable or Sonnet to `claude-sonnet-5-5` at medium; Qwen max or plus to Qwen flash; DeepSeek pro to flash; GLM and Seed to GLM flash; Mistral large to Mistral medium; other listed routes keep the model with effort capped at high).
- `child.fallbackModels` per rule, tried when the primary model is not in the chat's allow-list.
- Explicit choices by the main agent always win; `subagent_fork` is never touched.
- Rules overridable with a `subagent-tiering` row in the profile `cordis.patch.yml`.
- Troubleshooting guide, error reference and the `subagent-tiering-doctor` skill.
