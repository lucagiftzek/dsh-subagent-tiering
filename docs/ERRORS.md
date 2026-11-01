# Error codes: dsh-subagent-tiering

This plugin never fails a tool call: when it cannot or should not rewrite a `subagent` call
it leaves it alone and the child inherits the parent route. Its reserved prefix for future
codes is `TIERING_`. What you meet are its log lines and, at start, config validation errors.

## Runtime log lines

| Log line | Meaning | Agent action |
|---|---|---|
| `subagent-tiering: active, N rules` | entry mounted with N rules | none |
| `subagent-tiering: <p>/<m>@<e> -> <p>/<m>@<e>` | this call was rewritten to the child route | none |
| `subagent-tiering: inherit (model selection is off for this session)` | chat has no allow-list | [details](#inherit-off) |
| `subagent-tiering: inherit (<route> is not in the session's allowed routes)` | child route not allowed in this chat | [details](#inherit-not-allowed) |
| `subagent-tiering: inherit (<route> does not resolve)` | runtime rejects the route | [details](#inherit-unresolved) |
| `subagent-tiering: cannot rewrite tool arguments (...)` | call record frozen by the harness, logged once | [details](#frozen) |
| `subagent-tiering: skipped (...)` | unexpected error, call left alone | [details](#skipped) |

## Start-up validation errors (entry does not mount)

| Message | Fix |
|---|---|
| `subagent-tiering: enabled, promptHint and verbose must be booleans` | unquoted `true`/`false` |
| `subagent-tiering: toolNames must be a list of tool names` | a YAML list of non-empty strings |
| `subagent-tiering: subagent_fork must keep the parent route; do not list it` | remove `subagent_fork` from `toolNames` |
| `subagent-tiering: rules must be a list` | `rules:` must be a YAML list |
| `subagent-tiering: rules[i].match needs provider and model patterns` | both `match.provider` and `match.model` as strings |
| `subagent-tiering: rules[i].child.<key> must be a non-empty string` | `provider`, `model`, `reasoningEffort` non-empty strings |
| `subagent-tiering: rules[i].child.fallbackModels must be a list of model ids` | list of non-empty strings |
| `subagent-tiering: rules[i].child changes nothing` | set at least one of `provider`, `model`, `reasoningEffort` |

All of these: [TROUBLESHOOTING entry 4](TROUBLESHOOTING.md#t-bad-config). The human edits the
profile row; the agent proposes the exact corrected YAML.

<a id="inherit-off"></a>
### inherit: model selection is off for this session
- **Meaning:** the chat was created without the harness's subagent model-selection policy.
- **Needs the human:** yes, to enable it (and on DSH 0.2.x to re-create the allow-list after the
  update); then a NEW chat. [Entry 1](TROUBLESHOOTING.md#t-child-inherits), [entry 7](TROUBLESHOOTING.md#t-after-update).

<a id="inherit-not-allowed"></a>
### inherit: route not in the session's allowed routes
- **Meaning:** the allow-list captured at chat creation lacks the child route (and every fallback).
- **Agent action:** check with `list_subagent_models`; suggest a new chat or an allowed fallback.

<a id="inherit-unresolved"></a>
### inherit: route does not resolve
- **Meaning:** no credentials, unknown model id or disabled provider for the child route.
- **Needs the human:** to fix credentials or change the rule.

<a id="frozen"></a>
### cannot rewrite tool arguments
- **Meaning:** the harness no longer lets plugins rewrite the call; tiering is inert.
- **Needs the human:** report with the DSH version; update the plugin when available.

<a id="skipped"></a>
### skipped
- **Meaning:** an unexpected exception inside the plugin; the call proceeded unchanged.
- **Agent action:** collect the full log line and DSH version for a bug report.
