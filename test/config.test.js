import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  modelName,
  normalizeConfig,
  reasoningEffortFor,
  resolveModel,
} from '../src/config.js';

test('defaults fill an empty or broken configuration', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  const config = normalizeConfig({
    api_key: '  abc  ',
    model: 'gpt-5',
    fast_model: 'custom',
    custom_model: 'bad id with spaces',
    reasoning: 'max',
    max_tokens: '999999',
  });
  assert.equal(config.api_key, 'abc');
  assert.equal(config.model, 'mistral-large-4', 'an unknown model falls back');
  assert.equal(config.fast_model, 'custom');
  assert.equal(config.custom_model, '', 'an id that cannot be a model id is ignored');
  assert.equal(config.reasoning, 'medium');
  assert.equal(config.max_tokens, 32000);
  assert.equal(normalizeConfig({ max_tokens: 'x' }).max_tokens, 8000);
  assert.equal(normalizeConfig({ max_tokens: 10 }).max_tokens, 1024);
});

test('a select set to "custom" calls the custom id, null when it is empty', () => {
  const config = normalizeConfig({ model: 'custom', custom_model: 'mistral-medium-latest' });
  assert.equal(resolveModel(config, 'model'), 'mistral-medium-latest');
  assert.equal(resolveModel(config, 'fast_model'), 'ministral-8b-latest');
  assert.equal(resolveModel(normalizeConfig({ model: 'custom' }), 'model'), null);
  assert.equal(modelName('mistral-large-4'), 'Mistral Large 4');
  assert.equal(modelName('ft:open-mistral-7b:abc'), 'ft:open-mistral-7b:abc');
});

test('reasoning_effort: only values each model accepts', () => {
  // Large 4: low / medium / high, never off.
  assert.deepEqual(
    ['none', 'low', 'medium', 'high'].map((level) => reasoningEffortFor('mistral-large-4', level)),
    ['low', 'low', 'medium', 'high'],
  );
  // Small 4: none / high.
  assert.deepEqual(
    ['none', 'low', 'medium', 'high'].map((level) =>
      reasoningEffortFor('mistral-small-latest', level),
    ),
    ['none', 'none', 'high', 'high'],
  );
  // Ministral: nothing sent.
  assert.equal(reasoningEffortFor('ministral-8b-latest', 'high'), undefined);
  // Custom: as asked, except "none" which is not sent.
  assert.equal(reasoningEffortFor('magistral-medium-latest', 'medium'), 'medium');
  assert.equal(reasoningEffortFor('magistral-medium-latest', 'none'), undefined);
});
