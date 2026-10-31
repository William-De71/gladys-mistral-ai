// The whole integration against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`) and a fake Mistral API
// (test/helpers/fake-mistral.js), a real HTTP server on 127.0.0.1. No test
// touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import {
  AI_CHAT_PURPOSES,
  validateAiCompletion,
  validateWidgetContent,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS, createApp, SCENE_ACTIONS } from '../src/app.js';
import { TRIGGERS } from '../src/events.js';
import { WIDGETS } from '../src/widgets.js';
import { API_KEY, startFakeMistral } from './helpers/fake-mistral.js';

const start = async (t, config = { api_key: API_KEY }) => {
  const api = await startFakeMistral();
  const dir = await mkdtemp(join(tmpdir(), 'mistral-app-'));
  const gladys = createFakeGladys({ config });
  const app = createApp(gladys, {
    baseUrl: api.url,
    sleep: async () => {},
    usageFile: join(dir, 'usage.json'),
    timeZone: 'Europe/Paris',
  });
  await gladys.connect();
  await app.whenReady();
  t.after(async () => {
    app.usage.stop();
    await gladys.disconnect?.();
    await api.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { api, gladys, app };
};

test('connects: checks both models without spending a token, status OK', async (t) => {
  const { api, gladys } = await start(t);
  assert.deepEqual(
    api.requests.map((r) => r.path),
    ['/v1/models/mistral-large-4', '/v1/models/ministral-8b-latest'],
  );
  assert.equal(
    gladys.fake.connectionStatus?.connected ?? gladys.fake.connectionStatuses.at(-1)?.connected,
    true,
  );
});

test('without a key: status explains it, nothing is called', async (t) => {
  const { api, gladys } = await start(t, {});
  assert.equal(api.requests.length, 0);
  const status = gladys.fake.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(JSON.stringify(status), /console\.mistral\.ai/);
});

test('answers the AI requests of the core with valid completions', async (t) => {
  const { api, gladys } = await start(t);
  const ack = await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'Bonjour' }],
    tools: [
      { type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } },
    ],
    tool_choice: 'auto',
    purpose: AI_CHAT_PURPOSES.CHAT,
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(validateAiCompletion(ack.data), []);
  assert.equal(ack.data.choices[0].message.content, 'Bonjour !');
  assert.equal(api.requests.at(-1).body.tool_choice, 'auto');
});

test('a failing provider: the ack fails, one error event, status down, then recovery', async (t) => {
  const { api, gladys } = await start(t);
  for (let i = 0; i < 3; i += 1) {
    api.reply('POST /v1/chat/completions', { status: 401, body: { message: 'Unauthorized' } });
  }
  for (let i = 0; i < 3; i += 1) {
    const ack = await gladys.fake.aiChat({
      messages: [{ role: 'user', content: 'x' }],
      purpose: 'chat',
    });
    assert.equal(ack.success, false);
  }
  await tick();
  const errors = gladys.fake.sceneEvents.filter(
    (event) => (event.key ?? event.event_key) === TRIGGERS.ERROR,
  );
  assert.equal(errors.length, 1, JSON.stringify(gladys.fake.sceneEvents));
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, false);
  const ack = await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'x' }],
    purpose: 'chat',
  });
  assert.equal(ack.success, true);
  await tick();
  assert.ok(
    gladys.fake.sceneEvents.some((event) => (event.key ?? event.event_key) === TRIGGERS.RECOVERED),
  );
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, true);
});

test('the web search scene action returns its outputs', async (t) => {
  const { gladys } = await start(t);
  const ack = await gladys.fake.sceneAction(SCENE_ACTIONS.WEB_SEARCH, {
    question: 'Grève demain ?',
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(Object.keys(ack.data.outputs).sort(), ['answer', 'sources']);
  assert.match(ack.data.outputs.answer, /grève SNCF/);
  assert.match(ack.data.outputs.sources, /lemonde/);
});

test('the test button answers with each model and its time', async (t) => {
  const { gladys } = await start(t);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.equal(ack.success, true);
  const text = ack.data.message.fr;
  assert.match(text, /Discussion — Mistral Large 4 a répondu en/);
  assert.match(text, /Routeur — Ministral 3 8B a répondu en/);
});

test('the widget counts what was asked, valid in every language', async (t) => {
  const { gladys } = await start(t);
  await gladys.fake.aiChat({
    messages: [{ role: 'user', content: 'x' }],
    purpose: AI_CHAT_PURPOSES.INTENT_CLASSIFICATION,
  });
  await gladys.fake.aiChat({ messages: [{ role: 'user', content: 'x' }], purpose: 'chat' });
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await gladys.fake.widgetGet(WIDGETS.USAGE, { language });
    assert.equal(ack.success, true);
    assert.deepEqual(validateWidgetContent(ack.data.content), [], language);
    assert.equal(ack.data.content.components.find((c) => c.type === 'value').value, 2);
  }
});

test('a new configuration is applied and checked at once', async (t) => {
  const { api, gladys, app } = await start(t);
  api.reply('GET /v1/models', { status: 404, body: { detail: 'Not found' } });
  await gladys.fake.configUpdated({
    api_key: API_KEY,
    model: 'custom',
    custom_model: 'mistral-medium-latest',
  });
  assert.equal(app.getConfig().model, 'custom');
  const status = gladys.fake.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(JSON.stringify(status), /mistral-medium-latest/);
});
