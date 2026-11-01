// Copyright © 2026 · SPDX-License-Identifier: MIT
/**
 * dsh-subagent-tiering: delegate to a cheaper sibling model by default.
 *
 * WHY THIS EXISTS (2026-09-27)
 * 14 days of session logs: 70% of dsh's Anthropic calls were subagents, and the
 * stock `ptc` preset gives `subagent` no child defaults, so every child inherited
 * the parent's route and effort (Opus 5.5 at max, for greps and file reads).
 * `tool-subagent`'s own `agentOptions` is one static route, which cannot say
 * "Opus parent → Sonnet child, Qwen parent → Qwen-flash child".
 *
 * WHAT IT DOES
 * On `tools/pre-execute` for the `subagent` tool, when the calling model named no
 * provider/model/reasoning_effort, it fills them in from the first matching rule
 * (src/rules.js), exactly as if the model had asked. The stock tool then applies
 * its normal policy checks. The main agent keeps the final say: any explicit
 * route or effort in the call is left untouched.
 *
 * It changes nothing (the child inherits the parent, as before) when:
 *   - the session has no model-selection policy (`subagent-model-selection` off
 *     when the session was created), or the target route is not in it;
 *   - the live LLM runtime rejects the target route (the effort alone is dropped
 *     first if only the effort is refused);
 *   - core dsh ever freezes the execution record (logged once).
 * `subagent_fork` is never touched: a fork must keep the parent route to reuse
 * the parent's cached prefix.
 */
import { compileRules, DEFAULT_RULES, pickChildRoutes } from './rules.js';

export const name = 'subagent-tiering';
export const inject = ['systemPrompt'];

const POLICY_PROJECTION = 'subagentModelSelectionPolicy';

/**
 * Validate the plugin section.
 * @param {object} [config] - raw config from the cordis entry.
 */
export function validateConfig(config = {}) {
  const { enabled = true, toolNames = ['subagent'], rules = DEFAULT_RULES, promptHint = true, verbose = true } = config ?? {};
  if (typeof enabled !== 'boolean' || typeof promptHint !== 'boolean' || typeof verbose !== 'boolean')
    throw new Error('subagent-tiering: enabled, promptHint and verbose must be booleans');
  if (!Array.isArray(toolNames) || toolNames.some((n) => typeof n !== 'string' || n === ''))
    throw new Error('subagent-tiering: toolNames must be a list of tool names');
  if (toolNames.includes('subagent_fork'))
    throw new Error('subagent-tiering: subagent_fork must keep the parent route; do not list it');
  return { enabled, toolNames, compiled: compileRules(rules), promptHint, verbose };
}

/** The parent's effective route: the last request header, else its creation options. */
export function parentRoute(agent) {
  let config;
  try { config = agent?.session?.requestHeader?.()?.config; } catch { config = undefined; }
  const provider = config?.provider ?? agent?.options?.provider;
  const model = config?.model ?? agent?.options?.model;
  const reasoningEffort = config === undefined ? agent?.options?.reasoningEffort : config.reasoningEffort;
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
}

function hasExplicitRoute(args) {
  return args?.provider !== undefined || args?.model !== undefined || args?.reasoning_effort !== undefined;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Confirm the target through the live LLM runtime, the same call the stock
 * tool's preflight makes. Returns the usable target, possibly without its
 * effort, or undefined when the route itself does not resolve.
 */
async function resolveTarget(llm, target, signal) {
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return target;
  const { reasoningEffort, ...route } = target;
  if (reasoningEffort !== undefined) {
    try { await llm.resolveCallConfig({ ...route, reasoningEffort }, signal); return target; } catch { /* try without effort */ }
  }
  try { await llm.resolveCallConfig(route, signal); return route; } catch { return undefined; }
}

/**
 * Compute the rewritten arguments for one subagent call, or undefined to leave it.
 * Exported for tests; `deps` supplies the session policy and LLM runtime.
 */
export async function rewriteArguments(exec, config, deps) {
  if (!config.toolNames.includes(exec?.name)) return undefined;
  const args = exec.arguments;
  if (args === null || typeof args !== 'object' || hasExplicitRoute(args)) return undefined;
  const agent = exec.agent;
  if (agent === undefined) return undefined;
  const parent = parentRoute(agent);
  const candidates = pickChildRoutes(config.compiled, parent);
  if (candidates.length === 0) return undefined;

  const allowed = deps.allowedRoutes(agent);
  if (!Array.isArray(allowed)) return { skip: 'model selection is off for this session' };
  // First candidate the session allows and the runtime resolves wins; a
  // candidate that fails falls through to the rule's next fallback model.
  const skips = [];
  for (const wanted of candidates) {
    const routeChanged = wanted.provider !== parent.provider || wanted.model !== parent.model;
    const checkRoute = routeChanged ? wanted : parent;
    if (!allowed.some((r) => r.provider === checkRoute.provider && r.model === checkRoute.model)) {
      skips.push(`${checkRoute.provider}/${checkRoute.model} is not in the session's allowed routes`);
      continue;
    }
    const target = await resolveTarget(deps.llm(), wanted, exec.signal);
    if (target === undefined) { skips.push(`${wanted.provider}/${wanted.model} does not resolve`); continue; }
    if (!routeChanged && target.reasoningEffort === undefined) return undefined;

    const next = { ...args };
    if (routeChanged) { next.provider = target.provider; next.model = target.model; }
    if (target.reasoningEffort !== undefined) next.reasoning_effort = target.reasoningEffort;
    return { args: next, from: parent, to: { ...(routeChanged ? { provider: target.provider, model: target.model } : parent), reasoningEffort: target.reasoningEffort } };
  }
  return { skip: skips.join('; ') };
}

const PROMPT_HINT = [
  'Subagent routing: a `subagent` call that names no provider/model/reasoning_effort runs on a cheaper',
  'sibling of your own model (Opus/Fable → Sonnet 5.5 at medium; Qwen max → Qwen flash; DeepSeek pro → flash;',
  'other routes keep the model with effort capped at high). That suits search, reading, checks and routine',
  'edits. For a subtask that needs your full strength, pass `provider`, `model` and `reasoning_effort` explicitly',
  '(`list_subagent_models` shows the allowed routes).',
].join(' ');

/**
 * @param {object} ctx - cordis context.
 * @param {object} [rawConfig] - entry config.
 */
export function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig);
  if (!config.enabled) return;
  const logger = ctx.logger;
  let warnedFrozen = false;

  const deps = {
    allowedRoutes(agent) {
      const projections = ctx.get('sessionProjections');
      try { return projections?.stateOf(agent.session, POLICY_PROJECTION) ?? undefined; } catch { return undefined; }
    },
    llm: () => ctx.get('llm'),
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const out = await rewriteArguments(exec, config, deps);
      if (out?.skip !== undefined) {
        if (config.verbose) logger?.info?.(`subagent-tiering: inherit (${out.skip})`);
      } else if (out?.args !== undefined) {
        try {
          exec.arguments = deepFreeze(out.args);
          if (config.verbose)
            logger?.info?.(`subagent-tiering: ${out.from.provider}/${out.from.model}@${out.from.reasoningEffort ?? 'default'} -> ${out.to.provider}/${out.to.model}@${out.to.reasoningEffort ?? 'default'}`);
        } catch (error) {
          if (!warnedFrozen) logger?.warn?.(`subagent-tiering: cannot rewrite tool arguments (${String(error)}); children inherit the parent route`);
          warnedFrozen = true;
        }
      }
    } catch (error) {
      logger?.warn?.(`subagent-tiering: skipped (${String(error)})`);
    }
    return next();
  });

  if (config.promptHint) ctx.systemPrompt.section({ name: 'subagent-tiering', order: 85, text: PROMPT_HINT });
  logger?.info?.(`subagent-tiering: active, ${config.compiled.length} rules`);
}

export default { name, inject, apply };
