// Copyright © 2026 · SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, DEFAULT_RULES, pickChildRoute, pickChildRoutes } from '../src/rules.js';
import { rewriteArguments, validateConfig } from '../src/index.js';

const rules = compileRules(DEFAULT_RULES);
const pick = (provider, model, reasoningEffort) => pickChildRoute(rules, { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });

test('each family maps to its cheaper sibling', () => {
  assert.deepEqual(pick('anthropic', 'claude-opus-5-5', 'max'), { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' });
  assert.deepEqual(pick('anthropic', 'claude-fable-5-1', 'high'), { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' });
  assert.deepEqual(pick('anthropic', 'claude-sonnet-5', 'high'), { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' });
  assert.deepEqual(pick('alibaba', 'qwen3.8-max', 'max'), { provider: 'alibaba', model: 'qwen3.8-flash', reasoningEffort: 'high' });
  assert.deepEqual(pick('vision-toolkit-alibaba', 'deepseek-v4-pro', 'max'), { provider: 'vision-toolkit-alibaba', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });
  assert.deepEqual(pick('byteplus', 'deepseek-v4-pro-ga-260813'), { provider: 'byteplus', model: 'deepseek-v4-1-flash-260910', reasoningEffort: 'high' });
  assert.deepEqual(pick('deepseek-official', 'deepseek-v4-pro', 'max'), { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
  assert.deepEqual(pick('mistral', 'mistral-large-latest'), { provider: 'mistral', model: 'mistral-medium-latest' });
});

test('on the parent route an effort is only a cap, never a raise', () => {
  assert.deepEqual(pick('vision-toolkit-mistral', 'zai-glm-5-3', 'max'), { provider: 'vision-toolkit-mistral', model: 'zai-glm-5-3', reasoningEffort: 'high' });
  assert.equal(pick('vision-toolkit-mistral', 'zai-glm-5-3', 'high'), undefined);
  assert.equal(pick('vision-toolkit-mistral', 'zai-glm-5-3', 'low'), undefined);
  assert.equal(pick('vision-toolkit-mistral', 'zai-glm-5-3'), undefined);
  // same model, lower effort than the rule, route unchanged -> leave alone
  assert.equal(pick('anthropic', 'claude-sonnet-5-5', 'low'), undefined);
});

test('fallback models follow the primary, and stop at the parent route', () => {
  assert.deepEqual(pickChildRoutes(rules, { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max' }).map((r) => r.model),
    ['claude-sonnet-5-5', 'claude-sonnet-5']);
  // a Sonnet 5 parent at low: 5.5 is a route change; its own route would only raise effort -> dropped
  assert.deepEqual(pickChildRoutes(rules, { provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'low' }).map((r) => r.model),
    ['claude-sonnet-5-5']);
  assert.throws(() => compileRules([{ match: { provider: 'x', model: 'y' }, child: { model: 'z', fallbackModels: [''] } }]), /fallbackModels/);
});

test('unknown parents inherit', () => {
  assert.equal(pick('local', 'qwen3.5-9b', 'max'), undefined);
  assert.equal(pick('apimarket', 'x/y'), undefined);
});

test('config refuses subagent_fork and bad rules', () => {
  assert.throws(() => validateConfig({ toolNames: ['subagent_fork'] }), /fork/);
  assert.throws(() => validateConfig({ rules: [{ match: { provider: 'x' } }] }), /patterns/);
  assert.throws(() => validateConfig({ rules: [{ match: { provider: 'x', model: 'y' }, child: {} }] }), /changes nothing/);
});

const config = validateConfig({});
const agentOn = (provider, model, reasoningEffort) => ({ session: { requestHeader: () => ({ config: { provider, model, reasoningEffort } }) } });
const deps = (allowed, accept = () => true) => ({
  allowedRoutes: () => allowed,
  llm: () => ({ resolveCallConfig: async (c) => { if (!accept(c)) throw new Error('refused'); } }),
});
const ALLOWED = [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5' }];
// A chat created before 2026-09-29: its captured allow-list has no Sonnet 5.5.
const OLD_ALLOWED = [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'anthropic', model: 'claude-sonnet-5' }];

test('fills the route when the model named none', async () => {
  const out = await rewriteArguments({ name: 'subagent', arguments: { description: 'd', prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') }, config, deps(ALLOWED));
  assert.deepEqual(out.args, { description: 'd', prompt: 'p', provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning_effort: 'medium' });
});

test('an older chat without Sonnet 5.5 in its allow-list falls back to Sonnet 5', async () => {
  const out = await rewriteArguments({ name: 'subagent', arguments: { prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') }, config, deps(OLD_ALLOWED));
  assert.deepEqual(out.args, { prompt: 'p', provider: 'anthropic', model: 'claude-sonnet-5', reasoning_effort: 'medium' });
  // and a runtime that cannot resolve 5.5 also falls through
  const out2 = await rewriteArguments({ name: 'subagent', arguments: { prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') }, config, deps(ALLOWED, (c) => c.model !== 'claude-sonnet-5-5'));
  assert.equal(out2.args.model, 'claude-sonnet-5');
});

test('an explicit choice by the main agent is never touched', async () => {
  for (const extra of [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { reasoning_effort: 'max' }]) {
    const out = await rewriteArguments({ name: 'subagent', arguments: { prompt: 'p', ...extra }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') }, config, deps(ALLOWED));
    assert.equal(out, undefined);
  }
});

test('fork and other tools are never touched', async () => {
  for (const name of ['subagent_fork', 'bash']) {
    const out = await rewriteArguments({ name, arguments: { prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') }, config, deps(ALLOWED));
    assert.equal(out, undefined);
  }
});

test('no policy, or target not allowed -> inherit', async () => {
  const exec = { name: 'subagent', arguments: { prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') };
  assert.match((await rewriteArguments(exec, config, deps(undefined))).skip, /off/);
  assert.match((await rewriteArguments(exec, config, deps([ALLOWED[0]]))).skip, /claude-sonnet-5-5 is not in.*claude-sonnet-5 is not in/);
});

test('an effort the child refuses is dropped; a route that does not resolve is skipped', async () => {
  const exec = { name: 'subagent', arguments: { prompt: 'p' }, agent: agentOn('anthropic', 'claude-opus-5-5', 'max') };
  const noEffort = await rewriteArguments(exec, config, deps(ALLOWED, (c) => c.reasoningEffort === undefined));
  assert.deepEqual(noEffort.args, { prompt: 'p', provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const none = await rewriteArguments(exec, config, deps(ALLOWED, () => false));
  assert.match(none.skip, /does not resolve/);
});
