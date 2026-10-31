import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMistralClient,
  ERROR_KINDS,
  errorMessageOf,
  MistralError,
  parseRetryAfter,
} from '../src/mistral-api.js';
import { API_KEY, startFakeMistral } from './helpers/fake-mistral.js';

const client = (api, options = {}) => {
  const waits = [];
  const instance = createMistralClient({
    getApiKey: () => options.key ?? API_KEY,
    baseUrl: api.url,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...options,
  });
  return { instance, waits };
};

test('sends the key as a Bearer token and returns the JSON body', async (t) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const { instance } = client(api);
  const body = await instance.chat({
    model: 'mistral-large-4',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(body.choices[0].message.content, 'Bonjour !');
  assert.equal(api.requests[0].authorization, `Bearer ${API_KEY}`);
  assert.equal(api.requests[0].body.model, 'mistral-large-4');
  const card = await instance.retrieveModel('ministral-8b-latest');
  assert.equal(card.id, 'ministral-8b-latest');
  assert.equal(api.requests[1].path, '/v1/models/ministral-8b-latest');
});

test('no key: fails before any request', async (t) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const { instance } = client(api, { key: '' });
  await assert.rejects(
    instance.chat({}),
    (err) => err instanceof MistralError && err.kind === ERROR_KINDS.AUTH,
  );
  assert.equal(api.requests.length, 0);
});

test('HTTP failures become error kinds, the key never in the message', async (t) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const { instance } = client(api, { key: 'wrong-key' });
  await assert.rejects(
    instance.chat({}),
    (err) =>
      err.kind === ERROR_KINDS.AUTH &&
      /HTTP 401: Unauthorized/.test(err.message) &&
      !err.message.includes('wrong-key'),
  );
  const good = client(api).instance;
  api.reply('GET /v1/models', { status: 404, body: { detail: 'Model not found' } });
  await assert.rejects(good.retrieveModel('nope'), (err) => err.kind === ERROR_KINDS.MODEL);
  api.reply('POST /v1/chat/completions', {
    status: 422,
    body: {
      detail: [{ loc: ['body', 'reasoning_effort'], msg: 'Input should be low, medium or high' }],
    },
  });
  await assert.rejects(
    good.chat({}),
    (err) =>
      err.kind === ERROR_KINDS.REQUEST &&
      /body\.reasoning_effort: Input should be/.test(err.message),
  );
  api.reply('POST /v1/chat/completions', { status: 200, body: 'not json' });
  // Not JSON: a server fault, retried like a 5xx (here without retry).
  await assert.rejects(good.chat({}, { retries: false }), (err) => err.kind === ERROR_KINDS.SERVER);
});

test('429 and 5xx are retried with Retry-After or backoff, then give up', async (t) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const { instance, waits } = client(api);
  api.reply('POST /v1/chat/completions', {
    status: 429,
    body: { message: 'Requests rate limit exceeded' },
    headers: { 'Retry-After': '2' },
  });
  api.reply('POST /v1/chat/completions', { status: 503, body: { message: 'busy' } });
  const body = await instance.chat({});
  assert.equal(body.choices[0].message.content, 'Bonjour !');
  assert.deepEqual(waits, [2000, 2000]);
  for (let i = 0; i < 3; i += 1) {
    api.reply('POST /v1/chat/completions', {
      status: 429,
      body: { message: 'Requests rate limit exceeded' },
    });
  }
  await assert.rejects(instance.chat({}), (err) => err.kind === ERROR_KINDS.RATE_LIMIT);
  assert.equal(api.requests.length, 6);
  // The connection check never retries.
  api.reply('GET /v1/models', { status: 503, body: { message: 'busy' } });
  await assert.rejects(instance.retrieveModel('x'), (err) => err.kind === ERROR_KINDS.SERVER);
  assert.equal(api.requests.length, 7);
});

test('a wait that would not fit in the deadline fails at once with the real reason', async (t) => {
  const api = await startFakeMistral();
  t.after(api.close);
  const { instance, waits } = client(api);
  api.reply('POST /v1/chat/completions', {
    status: 429,
    body: { message: 'slow down' },
    headers: { 'Retry-After': '30' },
  });
  await assert.rejects(
    instance.chat({}, { timeoutMs: 18_000 }),
    (err) => err.kind === ERROR_KINDS.RATE_LIMIT,
  );
  assert.deepEqual(waits, []);
});

test('an unreachable API and a timeout are named as such', async () => {
  const unreachable = createMistralClient({
    getApiKey: () => 'k',
    baseUrl: 'http://127.0.0.1:9/v1',
    sleep: async () => {},
  });
  await assert.rejects(
    unreachable.chat({}, { retries: false }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const slow = createMistralClient({
    getApiKey: () => 'k',
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  // AbortSignal.timeout does not keep the process alive: this timer does.
  const hold = setTimeout(() => {}, 1000);
  await assert.rejects(
    slow.chat({}, { timeoutMs: 50, retries: false }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
  clearTimeout(hold);
});

test('error bodies and Retry-After are read safely', () => {
  assert.equal(errorMessageOf({ message: 'Bearer abc.def is invalid' }), 'Bearer *** is invalid');
  assert.equal(errorMessageOf({ error: { message: 'x' } }), 'x');
  assert.equal(errorMessageOf('x'.repeat(500)).length, 300);
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});
