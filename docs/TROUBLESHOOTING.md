# Troubleshooting dsh-subagent-tiering

Checked on: DSH 0.1.5-rc.1 (0.2.1-rc.5 notes where the settings moved), plugin 0.1.0.

<a id="start-here"></a>
**Start here.** Ask your agent to load the `subagent-tiering-doctor` skill (copy it into
`~/.dsh/skills/` first, see [the skill section](#skill)), or follow section 0. The plugin has
no routes, tools or UI. With `verbose: true` (the default) it logs one line per `subagent`
call saying what it did and why: that line answers most questions. Messages:
[ERRORS.md](ERRORS.md).

## Quick index

| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | Subagents still run on the parent's (expensive) model | chat has no model-selection policy, or the child route is not allowed | [1](#t-child-inherits) |
| 2 | Child runs on an older fallback model, not the expected one | the chat's captured allow-list predates the new model | [2](#t-fallback-model) |
| 3 | Child runs on the right model but at the wrong effort | another plugin overrides effort per step | [3](#t-wrong-effort) |
| 4 | The plugin entry fails at start with a `subagent-tiering: ...` message | invalid config or rules | [4](#t-bad-config) |
| 5 | A one-call subagent costs more than before | prompt cache cannot be shared across models | [5](#t-cost-one-call) |
| 6 | `subagent_fork` is not tiered | by design | [6](#t-fork) |
| 7 | After a DSH update, tiering stopped | model-selection settings moved on 0.2.x | [7](#t-after-update) |

## 0. Collect facts (read-only, always safe)

```bash
dsh --version
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).filter(b=>/tiering/.test(b)))' "$D/package.json"
grep -n -A8 'id: subagent-tiering' "$D/cordis.patch.yml"        # override row, if any
journalctl -u <your-dsh-unit> --since today | grep 'subagent-tiering' | tail -20
```

Healthy: `subagent-tiering: active, N rules` once per start, then per call either
`subagent-tiering: <parent> -> <child>` (rewritten) or `subagent-tiering: inherit (<reason>)`.

<a id="t-child-inherits"></a>
## 1. Subagents still run on the parent's model

**Likely causes** (the `inherit (...)` log line names which)
1. `inherit (model selection is off for this session)`: the chat was created while the
   harness's subagent model selection was disabled, so it has no allow-list. Only chats
   created after enabling it are tiered.
2. `inherit (<provider>/<model> is not in the session's allowed routes)`: the child route is
   not in the allow-list the chat captured when it was created.
3. `inherit (<provider>/<model> does not resolve)`: the runtime rejects the route (no
   credentials for that provider, unknown model id, provider disabled).
4. No log line at all for the call: the main agent passed `provider`, `model` or
   `reasoning_effort` itself (its choice always wins), or the tool has another name than the
   ones in `toolNames`, or the plugin is not active (no `active` line, see C1).
5. `cannot rewrite tool arguments`: the harness froze the call record; children inherit.

**Diagnose:** the log line for the call (section 0). For cause 2, list the chat's allowed
routes with the `list_subagent_models` tool from inside that chat.

**Fix**
- Cause 1: enable subagent model selection in the harness settings (0.1.5: `settings.yaml`
  section `subagent-model-selection: { enabled: true, allowedModels: [...] }`; 0.2.x: see
  [7](#t-after-update)) **[HUMAN]**, then start a NEW chat.
- Cause 2: add the route to `allowedModels`, then start a new chat (existing chats keep the
  list they captured), or use a rule `fallbackModels` entry that existing chats allow.
- Cause 3: configure the provider's credentials, or change the rule's child model.
- Cause 4: expected when the agent named a route; otherwise check `toolNames` and C1.
- Cause 5: report it with your DSH version; the plugin logs it once and stays harmless.

**Verify:** a new `subagent` call without route fields logs `subagent-tiering: ... -> ...`,
and the child session's first request header shows the child model and effort.

<a id="t-fallback-model"></a>
## 2. The child runs on a fallback model

A rule's `child.fallbackModels` are tried in order when the primary model is not in the
chat's captured allow-list or does not resolve. Chats created before you added a newer model
to the allow-list keep falling back. **Fix:** start a new chat. **Verify:** the log line shows
the primary model.

<a id="t-wrong-effort"></a>
## 3. The right child model, but the wrong effort

Another plugin that sets reasoning effort per step (an "adaptive reasoning" style plugin)
overrides the effort the rule chose if it lists the child's route among its own routes.
**Fix:** remove the child routes (including fallbacks) from that plugin's route list **[HUMAN]**.

<a id="t-bad-config"></a>
## 4. The entry fails at start with a `subagent-tiering:` message

Config is validated at start; a bad value stops the entry (subagents then simply inherit).
See [ERRORS.md](ERRORS.md) for every message. Most common: a rule whose `child` sets nothing,
`toolNames` containing `subagent_fork`, a quoted boolean. Rules use JavaScript regular
expressions as strings: escape backslashes in YAML (`'^claude-opus'` is safest, single quotes).

```yaml
- id: subagent-tiering
  config:
    enabled: true
    verbose: true
    rules:
      - match: { provider: '^anthropic$', model: '^claude-opus' }
        child: { model: '<cheaper-model-id>', reasoningEffort: medium, fallbackModels: ['<older-cheaper-model-id>'] }
```
A `rules` list REPLACES the built-in list (it is not merged): copy the built-in rules from
`src/rules.js` and edit them.

<a id="t-cost-one-call"></a>
## 5. A one-call subagent costs more than before

A child on a different model cannot reuse the parent's prompt cache, so its first call pays
a full cache write. Subagents that make many calls come out well ahead; very short ones may
not. **Fix:** for a one-shot lookup the agent can pass the parent's route explicitly, or use
`subagent_fork`.

<a id="t-fork"></a>
## 6. `subagent_fork` is not tiered

By design: a fork must stay on the parent route to reuse its cached prefix. Listing
`subagent_fork` in `toolNames` is refused at start.

<a id="t-after-update"></a>
## 7. Tiering stopped after a DSH update

On DSH 0.2.x the subagent model-selection settings live under a renamed entry
(`subagent-model-selection-settings`), and the old `settings.yaml` section
`subagent-model-selection` (including `allowedModels`) is NOT imported automatically when
0.2.x renames `settings.yaml` to `settings.yaml.imported`. Chats then have no allow-list and
every call logs `inherit (model selection is off for this session)`.
**Fix:** re-create the allow-list in the new entry's row or settings form **[HUMAN]**, start a
new chat. **Verify:** as in [1](#t-child-inherits).

<a id="skill"></a>
## The doctor skill

This version does not register its skill automatically; copy it once:
```bash
P=$(node -p "require('path').dirname(require.resolve('dsh-subagent-tiering/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))")
mkdir -p "${DSH_HOME:-$HOME/.dsh}/skills" && cp -r "$P/skills/subagent-tiering-doctor" "${DSH_HOME:-$HOME/.dsh}/skills/"
```

<!-- dsh-common-install:v1 -->
## Common install problems on DSH

Placeholders: `DSH_HOME` defaults to `~/.dsh`, the profile is `web`. Items that cannot apply
to this plugin (routes, UI, webhooks, media) are left out; numbering follows the shared standard.

<a id="c1-not-loaded"></a>
### C1. The plugin does not appear at all (no `active` line)

**Causes:** (1) installed but not in the profile's bundle list; (2) in the list but `dsh web`
not restarted; (3) DSH refused it as incompatible (engines or peer range); (4) its entry
threw at start (see [4](#t-bad-config)).

**Diagnose**
```bash
D="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node -e 'const p=require(process.argv[1]);console.log((p.dsh?.profile?.bundles||[]).join("\n"))' "$D/package.json" | grep -n 'dsh-subagent-tiering' || echo "NOT IN BUNDLES"
ls -la "$D/node_modules/dsh-subagent-tiering" 2>/dev/null || echo "NOT INSTALLED"
dsh --profile web --dump-config 2>/dev/null | grep -n 'subagent-tiering' | head    # composed tree, does not boot
journalctl -u <your-dsh-unit> --since "1 hour ago" | grep -i -E 'tiering|incompatible|skipped|exemption|duplicate loader entry' | tail -40
```

**Fix:** `dsh plugin --profile web add <package-or-path>` (adds it to `dsh.profile.bundles`
because the package declares `dsh.bundle`), then restart `dsh web` **[HUMAN if your chat runs
inside dsh web]**. The package's own patch inserts the entry: override values with a plain
`- id: subagent-tiering` row (`config:` only); a second `insert` row makes DSH report
`duplicate loader entry id`. If the log says the bundle was skipped as incompatible, update
the plugin; DSH 0.2.x also offers an exact-version exemption (`dsh plugin allow-version`, see
the log message), granted again after every DSH version change.

<a id="c3-settings-not-saved"></a>
### C3. Settings do not apply

No settings form on either DSH line: values come from the package patch, overridden by the
profile row. A section in `settings.yaml` is not read by this plugin (the harness's own
`subagent-model-selection` section is a different thing, see [7](#t-after-update)). Back up
`cordis.patch.yml` before editing it.

<a id="c6-oom-install"></a>
### C6. The machine runs out of memory during an install

A profile-level `pnpm install` can grow to many GB on a large profile; with swap full, the
kernel or earlyoom kills unrelated services. Check `free -m`, then:
```bash
systemd-run --user --scope -p MemoryMax=3G dsh plugin --profile web add <package-or-path>
```
<!-- /dsh-common-install -->
