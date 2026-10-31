// -----------------------------------------------------------------------------
// Scene action `web_search`: a question answered by Mistral with its built-in
// web search (Conversations API, POST /v1/conversations, tool `web_search`, or
// `web_search_premium` which adds news agencies). The chat of Gladys has no
// web access; this action gives a scene a fresh answer ("the news of the
// day", "is the A7 motorway blocked?") to send in a notification.
//
// `store: false`: the conversation is not kept on La Plateforme. The answer
// comes back as text chunks and `tool_reference` chunks (the sources).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { resolveModel } from './config.js';
import { ERROR_KINDS, MistralError } from './mistral-api.js';

const logger = createLogger({ name: 'web-search' });

export const WEB_SEARCH_TIMEOUT_MS = 85_000;
const MAX_QUESTION = 1000;
const MAX_ANSWER = 10_000;
const MAX_SOURCES = 5;

const INSTRUCTIONS =
  'You answer for a home automation scene: the text may be read aloud or sent as a phone notification. ' +
  'Search the web when the question needs fresh facts. Answer in the language of the question, briefly ' +
  '(a few sentences), in plain text without Markdown, links or source list.';

/**
 * @description The text and the sources of a conversation response.
 * @param {object} response - `{ outputs: [...] }`.
 * @returns {{ answer: string, sources: Array<{ title: string, url: string }> }} What was found.
 */
export function readConversation(response) {
  const outputs = Array.isArray(response?.outputs) ? response.outputs : [];
  const messages = outputs.filter((entry) => entry?.type === 'message.output');
  let answer = '';
  const sources = [];
  const seen = new Set();
  for (const entry of messages) {
    const chunks =
      typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : entry.content;
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (chunk?.type === 'text' && typeof chunk.text === 'string') {
        answer += chunk.text;
      } else if (chunk?.type === 'tool_reference') {
        const url =
          typeof chunk.url === 'string' && /^https?:\/\//.test(chunk.url) ? chunk.url : '';
        const title = String(chunk.title ?? '').trim();
        const key = url || title;
        if (key && !seen.has(key)) {
          seen.add(key);
          sources.push({ title, url });
        }
      }
    }
  }
  return { answer: answer.trim(), sources };
}

/**
 * @description The sources as one text: "Title — https://…" per line.
 * @param {Array<{ title: string, url: string }>} sources - The sources.
 * @returns {string} The lines.
 */
export function formatSources(sources) {
  return sources
    .slice(0, MAX_SOURCES)
    .map(({ title, url }) => [title, url].filter(Boolean).join(' — '))
    .join('\n');
}

/**
 * @description Create the scene action handler.
 * @param {object} options - Options.
 * @param {object} options.client - The Mistral client.
 * @param {() => object} options.getConfig - The normalized config.
 * @param {object} [options.usage] - The usage store.
 * @param {(err: MistralError, context: object) => void} [options.onFailure] - Failure hook.
 * @param {() => void} [options.onSuccess] - Success hook.
 * @param {() => number} [options.now] - Clock.
 * @returns {(fields: object) => Promise<object>} The handler: `{ answer, sources }`.
 */
export function createWebSearchHandler({
  client,
  getConfig,
  usage,
  onFailure = () => {},
  onSuccess = () => {},
  now = Date.now,
}) {
  return async function webSearch(fields = {}) {
    const question = String(fields.question ?? '').trim();
    if (!question) {
      throw new Error('The question is empty');
    }
    const config = getConfig();
    const model = resolveModel(config, 'model');
    const started = now();
    try {
      if (!model) {
        throw new MistralError(
          ERROR_KINDS.MODEL,
          'The custom model id of the configuration is empty',
        );
      }
      const extra = String(fields.instructions ?? '').trim();
      const response = await client.conversation(
        {
          model,
          inputs: question.slice(0, MAX_QUESTION),
          instructions: extra ? `${INSTRUCTIONS}\n${extra.slice(0, MAX_QUESTION)}` : INSTRUCTIONS,
          tools: [{ type: fields.premium === true ? 'web_search_premium' : 'web_search' }],
          completion_args: { max_tokens: config.max_tokens },
          store: false,
        },
        { timeoutMs: WEB_SEARCH_TIMEOUT_MS },
      );
      const { answer, sources } = readConversation(response);
      if (!answer) {
        throw new MistralError(ERROR_KINDS.SERVER, 'Mistral returned no text for this question');
      }
      const ms = now() - started;
      logger.info(
        `web search: answered in ${(ms / 1000).toFixed(1)} s with ${sources.length} source(s)`,
      );
      usage?.recordSuccess({ use: 'web', model, usage: response?.usage, ms });
      onSuccess();
      return { answer: answer.slice(0, MAX_ANSWER), sources: formatSources(sources) };
    } catch (err) {
      const error =
        err instanceof MistralError
          ? err
          : new MistralError(ERROR_KINDS.SERVER, err?.message ?? String(err));
      logger.warn(`web search failed (${error.kind}): ${error.message}`);
      usage?.recordError({ use: 'web', model, kind: error.kind, message: error.message });
      onFailure(error, { use: 'web', model });
      throw error;
    }
  };
}
