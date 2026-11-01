// Copyright © 2026 · SPDX-License-Identifier: MIT
/**
 * Default parent → child routing for subagents: each parent family delegates to
 * its own cheaper sibling. `child.provider` omitted = keep the parent's provider
 * id, so a `vision-toolkit-<x>` wrapper route stays wrapped. `reasoningEffort`
 * is checked against the live catalog before use and dropped if the child model
 * does not accept it (the child then runs at its model default).
 *
 * Order matters: the first rule whose provider AND model patterns match wins.
 * A parent that matches no rule is left alone (the child inherits the parent).
 */
export const DEFAULT_RULES = [
  // Anthropic (Claude Max subscription): Opus/Fable parents → Sonnet 5.5 (2026-09-29;
  // was Sonnet 5). Chats created before 5.5 was added keep an allow-list without
  // it, so Sonnet 5 stays as the fallback instead of silently inheriting Opus.
  { match: { provider: '^anthropic$', model: '^claude-(opus|fable)' },
    child: { model: 'claude-sonnet-5-5', reasoningEffort: 'medium', fallbackModels: ['claude-sonnet-5'] } },
  { match: { provider: '^anthropic$', model: '^claude-sonnet' },
    child: { model: 'claude-sonnet-5-5', reasoningEffort: 'medium', fallbackModels: ['claude-sonnet-5'] } },

  // BytePlus Coding Plan: pro → flash; flash-class stays, effort capped at high.
  { match: { provider: '^(vision-toolkit-)?byteplus$', model: '^deepseek-v4' },
    child: { model: 'deepseek-v4-1-flash-260910', reasoningEffort: 'high' } },
  { match: { provider: '^(vision-toolkit-)?byteplus$', model: '^(glm|seed)' },
    child: { model: 'glm-5-3-flash-260828', reasoningEffort: 'high' } },

  // Alibaba token plan: Qwen max/plus → Qwen flash; DeepSeek pro → flash; GLM keeps its model.
  { match: { provider: '^(vision-toolkit-)?alibaba$', model: '^qwen' },
    child: { model: 'qwen3.8-flash', reasoningEffort: 'high' } },
  { match: { provider: '^(vision-toolkit-)?alibaba$', model: '^deepseek-v4' },
    child: { model: 'deepseek-v4.1-flash', reasoningEffort: 'high' } },
  { match: { provider: '^(vision-toolkit-)?alibaba$', model: '^glm' },
    child: { reasoningEffort: 'high' } },

  // Mistral (Vibe flat subscription): large → medium; everything else keeps its model.
  { match: { provider: '^(vision-toolkit-)?mistral$', model: '^mistral-large' },
    child: { model: 'mistral-medium-latest' } },
  { match: { provider: '^(vision-toolkit-)?mistral$', model: '.' },
    child: { reasoningEffort: 'high' } },

  // DeepSeek official API (metered): pro → flash.
  { match: { provider: '^deepseek-official$', model: '.' },
    child: { model: 'deepseek-flash', reasoningEffort: 'high' } },

  // Hetzner inference (metered): same model, effort capped.
  { match: { provider: '^(vision-toolkit-)?hetzner$', model: '.' },
    child: { reasoningEffort: 'high' } },
];

/**
 * Validate and compile a rule list.
 * @param {unknown} rules - raw rules from config.
 * @returns {Array<{provider: RegExp, model: RegExp, child: {provider?: string, model?: string, reasoningEffort?: string, fallbackModels?: string[]}}>}
 */
export function compileRules(rules) {
  if (!Array.isArray(rules)) throw new Error('subagent-tiering: rules must be a list');
  return rules.map((rule, i) => {
    const where = `subagent-tiering: rules[${i}]`;
    if (typeof rule?.match?.provider !== 'string' || typeof rule?.match?.model !== 'string')
      throw new Error(`${where}.match needs provider and model patterns`);
    const child = rule.child ?? {};
    for (const key of ['provider', 'model', 'reasoningEffort'])
      if (child[key] !== undefined && (typeof child[key] !== 'string' || child[key] === ''))
        throw new Error(`${where}.child.${key} must be a non-empty string`);
    if (child.fallbackModels !== undefined && (!Array.isArray(child.fallbackModels)
        || child.fallbackModels.some((m) => typeof m !== 'string' || m === '')))
      throw new Error(`${where}.child.fallbackModels must be a list of model ids`);
    if (child.provider === undefined && child.model === undefined && child.reasoningEffort === undefined)
      throw new Error(`${where}.child changes nothing`);
    return { provider: new RegExp(rule.match.provider), model: new RegExp(rule.match.model), child: { ...child } };
  });
}

/**
 * Pick the child route for a parent route.
 * @param {ReturnType<typeof compileRules>} compiled - compiled rules.
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} parent - parent route.
 * @returns {{provider: string, model: string, reasoningEffort?: string} | undefined} target, or undefined to inherit.
 */
export function pickChildRoute(compiled, parent) {
  return pickChildRoutes(compiled, parent)[0];
}

/**
 * All candidate child routes for a parent, in preference order: the rule's
 * model first, then each of its `fallbackModels` (same provider and effort).
 * The caller takes the first one the session allows and the runtime resolves.
 * @param {ReturnType<typeof compileRules>} compiled - compiled rules.
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} parent - parent route.
 * @returns {Array<{provider: string, model: string, reasoningEffort?: string}>} candidates (may be empty).
 */
export function pickChildRoutes(compiled, parent) {
  if (!parent?.provider || !parent?.model) return [];
  const rule = compiled.find((r) => r.provider.test(parent.provider) && r.model.test(parent.model));
  if (rule === undefined) return [];
  const models = [rule.child.model ?? parent.model, ...(rule.child.fallbackModels ?? [])];
  const out = [];
  for (const model of models) {
    const target = {
      provider: rule.child.provider ?? parent.provider,
      model,
      ...(rule.child.reasoningEffort === undefined ? {} : { reasoningEffort: rule.child.reasoningEffort }),
    };
    const sameRoute = target.provider === parent.provider && target.model === parent.model;
    // On the parent's own route an effort is only ever a CAP: never raise a parent
    // that runs lower, and leave a parent on its model default alone. Reaching
    // the parent's own route also ends the list: a later fallback would be a
    // step away from what the parent already runs.
    if (sameRoute) {
      if (effortRank(parent.reasoningEffort) > effortRank(target.reasoningEffort)) out.push(target);
      break;
    }
    out.push(target);
  }
  return out;
}

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Position of an effort id in the shared scale; -1 when absent or unknown. */
function effortRank(effort) {
  return effort === undefined ? -1 : EFFORT_ORDER.indexOf(effort);
}
