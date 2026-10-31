// -----------------------------------------------------------------------------
// A fake Mistral API on 127.0.0.1, for the tests: real HTTP, no network.
//
// Every request is recorded (`requests`); the answer of each route comes from
// a queue of handlers (`reply(route, handler)`), or a default one. A handler
// returns `{ status, body, headers }`. The fixtures follow the shapes of the
// official Python client (mistralai/client-python, docs/models): they are not
// captured from the real API.
//
// `node --test` also runs this file: nothing starts on import.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';

export const API_KEY = 'test-mistral-key-0123456789';

/**
 * @description A chat completion as Mistral returns it.
 * @param {object} [message] - The assistant message.
 * @param {object} [extra] - Other fields (finish_reason, usage).
 * @returns {object} The body.
 */
export function completion(message = { role: 'assistant', content: 'Bonjour !' }, extra = {}) {
  return {
    id: 'cmpl-5f0c0d8e',
    object: 'chat.completion',
    model: 'mistral-large-4',
    created: 1793480400,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', ...message },
        finish_reason: extra.finish_reason ?? 'stop',
      },
    ],
    usage: extra.usage ?? { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
  };
}

/**
 * @description A conversation response with web search.
 * @returns {object} The body.
 */
export function webSearchConversation() {
  return {
    object: 'conversation.response',
    conversation_id: 'conv_0193',
    outputs: [
      { object: 'entry', type: 'tool.execution', name: 'web_search', id: 'tool_1' },
      {
        object: 'entry',
        type: 'message.output',
        role: 'assistant',
        model: 'mistral-large-4',
        content: [
          { type: 'text', text: 'La grève SNCF est reconduite demain' },
          {
            type: 'tool_reference',
            tool: 'web_search',
            title: 'Le Monde',
            url: 'https://www.lemonde.fr/a',
          },
          { type: 'text', text: ', avec un TGV sur deux.' },
          {
            type: 'tool_reference',
            tool: 'web_search',
            title: 'Le Monde',
            url: 'https://www.lemonde.fr/a',
          },
          {
            type: 'tool_reference',
            tool: 'web_search',
            title: 'France Info',
            url: 'https://www.francetvinfo.fr/b',
          },
        ],
      },
    ],
    usage: {
      prompt_tokens: 3000,
      completion_tokens: 40,
      total_tokens: 3040,
      connector_tokens: 900,
    },
  };
}

const MODEL_CARD = (id) => ({
  id,
  object: 'model',
  capabilities: { completion_chat: true, function_calling: true, vision: true },
});

/**
 * @description Start the fake API.
 * @returns {Promise<object>} `{ url, requests, reply, close }`.
 */
export async function startFakeMistral() {
  const requests = [];
  const queues = new Map();
  const defaults = {
    'POST /v1/chat/completions': () => ({ status: 200, body: completion() }),
    'POST /v1/conversations': () => ({ status: 200, body: webSearchConversation() }),
    'GET /v1/models': (request) => ({
      status: 200,
      body: MODEL_CARD(request.path.split('/').pop()),
    }),
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = decodeURIComponent(req.url);
      const route = `${req.method} ${path.startsWith('/v1/models/') ? '/v1/models' : path}`;
      const request = {
        route,
        path,
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(request);
      let answer;
      if (request.authorization !== `Bearer ${API_KEY}`) {
        answer = { status: 401, body: { message: 'Unauthorized', request_id: 'r1' } };
      } else {
        const queue = queues.get(route);
        const handler = queue?.length ? queue.shift() : defaults[route];
        answer = handler ? handler(request) : { status: 404, body: { detail: 'Not Found' } };
      }
      res.writeHead(answer.status, {
        'Content-Type': 'application/json',
        ...(answer.headers ?? {}),
      });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    /**
     * @description Queue the answer of the next request of a route.
     * @param {string} route - "POST /v1/chat/completions", "GET /v1/models"…
     * @param {Function|object} handler - `(request) => answer`, or the answer.
     */
    reply(route, handler) {
      if (!queues.has(route)) {
        queues.set(route, []);
      }
      queues.get(route).push(typeof handler === 'function' ? handler : () => handler);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
