import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { createMistralClient, ERROR_KINDS } from '../src/mistral-api.js';
import { createWebSearchHandler, formatSources, readConversation } from '../src/websearch.js';
import { API_KEY, startFakeMistral } from './helpers/fake-mistral.js';

const setup = async (t, raw = {}) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const config = normalizeConfig({ api_key: API_KEY, ...raw });
  const client = createMistralClient({
    getApiKey: () => config.api_key,
    baseUrl: api.url,
    sleep: async () => {},
  });
  const seen = { success: [], failures: [] };
  const handler = createWebSearchHandler({
    client,
    getConfig: () => config,
    usage: { recordSuccess: (e) => seen.success.push(e), recordError: () => {} },
    onFailure: (err) => seen.failures.push(err.kind),
  });
  return { api, handler, seen };
};

test('asks the Conversations API with web_search, without storing, and returns the declared outputs', async (t) => {
  const { api, handler, seen } = await setup(t);
  const outputs = await handler({ question: 'Grève SNCF demain ?', instructions: 'Une phrase.' });
  assert.deepEqual(Object.keys(outputs).sort(), ['answer', 'sources']);
  assert.equal(outputs.answer, 'La grève SNCF est reconduite demain, avec un TGV sur deux.');
  assert.equal(
    outputs.sources,
    'Le Monde — https://www.lemonde.fr/a\nFrance Info — https://www.francetvinfo.fr/b',
  );
  const { body } = api.requests[0];
  assert.equal(api.requests[0].route, 'POST /v1/conversations');
  assert.equal(body.model, 'mistral-large-4');
  assert.equal(body.inputs, 'Grève SNCF demain ?');
  assert.equal(body.store, false);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
  assert.match(body.instructions, /plain text[\s\S]*\nUne phrase\.$/);
  assert.equal(seen.success[0].use, 'web');
});

test('premium search, empty question, failures', async (t) => {
  const { api, handler, seen } = await setup(t);
  await handler({ question: 'x', premium: true });
  assert.deepEqual(api.requests[0].body.tools, [{ type: 'web_search_premium' }]);
  await assert.rejects(handler({ question: '   ' }), /empty/);
  api.reply('POST /v1/conversations', {
    status: 403,
    body: { message: 'web_search not allowed on this plan' },
  });
  await assert.rejects(handler({ question: 'x' }), (err) => err.kind === ERROR_KINDS.AUTH);
  api.reply('POST /v1/conversations', { status: 200, body: { outputs: [] } });
  await assert.rejects(handler({ question: 'x' }), /no text/);
  assert.deepEqual(seen.failures, ['auth', 'server']);
});

test('a plain string answer and source lists are read', () => {
  assert.deepEqual(readConversation({ outputs: [{ type: 'message.output', content: ' Oui. ' }] }), {
    answer: 'Oui.',
    sources: [],
  });
  assert.deepEqual(readConversation(null), { answer: '', sources: [] });
  const many = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://e.x/${i}` }));
  assert.equal(formatSources(many).split('\n').length, 5);
  assert.equal(formatSources([{ title: 'Sans lien', url: '' }]), 'Sans lien');
});
