import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_CHAT_PURPOSES, validateAiCompletion } from '@gladysassistant/integration-sdk';
import { buildBody, createChatHandler, useOf } from '../src/chat.js';
import { normalizeConfig } from '../src/config.js';
import { createMistralClient, ERROR_KINDS } from '../src/mistral-api.js';
import { API_KEY, completion, startFakeMistral } from './helpers/fake-mistral.js';

const TOOLS = [
  {
    type: 'function',
    function: { name: 'device_set_value', parameters: { type: 'object', properties: {} } },
  },
];

const setup = async (t, raw = {}) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const config = normalizeConfig({ api_key: API_KEY, ...raw });
  const client = createMistralClient({
    getApiKey: () => config.api_key,
    baseUrl: api.url,
    sleep: async () => {},
  });
  const recorded = { success: [], error: [], failures: [], successes: 0 };
  const usage = {
    recordSuccess: (entry) => recorded.success.push(entry),
    recordError: (entry) => recorded.error.push(entry),
  };
  const handler = createChatHandler({
    client,
    getConfig: () => config,
    usage,
    onFailure: (err, context) => recorded.failures.push({ kind: err.kind, ...context }),
    onSuccess: () => {
      recorded.successes += 1;
    },
  });
  return { api, handler, recorded, config };
};

test('the router gets the fast model without reasoning; the chat the main model with tools', async (t) => {
  const { api, handler, recorded } = await setup(t);
  await handler({
    messages: [
      { role: 'system', content: 'Classify' },
      { role: 'user', content: 'Allume' },
    ],
    purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION,
  });
  const router = api.requests[0].body;
  assert.equal(router.model, 'ministral-8b-latest');
  assert.equal(router.reasoning_effort, undefined);
  assert.equal(router.tools, undefined);

  const answer = await handler({
    messages: [{ role: 'user', content: 'Allume le salon' }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 2000,
    purpose: AI_CHAT_PURPOSES.CHAT,
    categories: ['devices'],
  });
  const chat = api.requests[1].body;
  assert.equal(chat.model, 'mistral-large-4');
  assert.equal(chat.reasoning_effort, 'medium');
  assert.equal(chat.tool_choice, 'any');
  assert.equal(chat.max_tokens, 8000, 'the configured budget when the caller asks less');
  assert.equal(chat.purpose, undefined);
  assert.equal(chat.categories, undefined);
  assert.deepEqual(validateAiCompletion(answer), []);
  assert.deepEqual(
    recorded.success.map((entry) => entry.use),
    ['router', 'chat'],
  );
  assert.equal(recorded.successes, 2);
});

test('the purposes are counted as router, digest or chat', () => {
  assert.equal(useOf(AI_CHAT_PURPOSES.INTENT_CLASSIFICATION), 'router');
  assert.equal(useOf(AI_CHAT_PURPOSES.WEEKLY_DIGEST), 'digest');
  assert.equal(useOf(AI_CHAT_PURPOSES.CHAT), 'chat');
  assert.equal(useOf(undefined), 'chat');
});

test('no tools: neither tools nor tool_choice is sent', () => {
  const body = buildBody(
    { messages: [], tools: [], tool_choice: 'auto' },
    normalizeConfig({ api_key: 'k' }),
  );
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test('a custom model that refuses reasoning_effort is asked again without it, then never', async (t) => {
  const { api, handler } = await setup(t, { model: 'custom', custom_model: 'open-mistral-nemo' });
  api.reply('POST /v1/chat/completions', {
    status: 400,
    body: { message: 'reasoning_effort is not supported for this model' },
  });
  const answer = await handler({
    messages: [{ role: 'user', content: 'Bonjour' }],
    purpose: 'chat',
  });
  assert.equal(answer.choices[0].message.content, 'Bonjour !');
  assert.equal(api.requests[0].body.reasoning_effort, 'medium');
  assert.equal(api.requests[1].body.reasoning_effort, undefined);
  await handler({ messages: [{ role: 'user', content: 'Encore' }], purpose: 'chat' });
  assert.equal(api.requests[2].body.reasoning_effort, undefined);
});

test('failures are thrown (the core names them), counted and reported once each', async (t) => {
  const { api, handler, recorded } = await setup(t);
  api.reply('POST /v1/chat/completions', { status: 401, body: { message: 'Unauthorized' } });
  await assert.rejects(
    handler({ messages: [], purpose: 'chat' }),
    (err) => err.kind === ERROR_KINDS.AUTH,
  );
  assert.deepEqual(recorded.failures, [{ kind: 'auth', use: 'chat', model: 'mistral-large-4' }]);
  assert.equal(recorded.error[0].kind, 'auth');

  api.reply('POST /v1/chat/completions', {
    status: 400,
    body: { message: 'Image input not supported' },
  });
  await assert.rejects(
    handler({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
        },
      ],
      purpose: 'chat',
    }),
    /choose a model that reads images/,
  );
});

test('an answer cut before any text fails clearly; a cut text is still returned', async (t) => {
  const { api, handler } = await setup(t);
  api.reply('POST /v1/chat/completions', {
    status: 200,
    body: completion(
      { content: [{ type: 'thinking', thinking: [] }] },
      { finish_reason: 'length' },
    ),
  });
  await assert.rejects(handler({ messages: [], purpose: 'chat' }), /cut at max_tokens/);
  api.reply('POST /v1/chat/completions', {
    status: 200,
    body: completion({ content: 'Le début' }, { finish_reason: 'length' }),
  });
  const answer = await handler({ messages: [], purpose: 'chat' });
  assert.equal(answer.choices[0].message.content, 'Le début');
});

test('a custom model without id fails without calling Mistral', async (t) => {
  const { api, handler } = await setup(t, { fast_model: 'custom' });
  await assert.rejects(
    handler({ messages: [], purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION }),
    (err) => err.kind === ERROR_KINDS.MODEL,
  );
  assert.equal(api.requests.length, 0);
});
