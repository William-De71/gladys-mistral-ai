// -----------------------------------------------------------------------------
// The AI provider: one OpenAI chat completion in, one out, answered by Mistral.
//
// The whole agentic loop (prompts, tools, history) stays in the Gladys core:
// this handler picks the model, translates the request (convert.js), calls
// /v1/chat/completions and translates the answer back. It runs no tool.
//
// What each `purpose` gets:
//   - `intent-classification` (the router, before every chat turn): the fast
//     model with the least reasoning, under 18 s (the core waits 20 s);
//   - `chat`, `weekly-digest` and anything else: the main model at the
//     reasoning level of the configuration, under 110 s (the core waits 120 s).
// -----------------------------------------------------------------------------

import { AI_CHAT_PURPOSES, createLogger } from '@gladysassistant/integration-sdk';
import { MAX_TOKENS_MAX, modelName, reasoningEffortFor, resolveModel } from './config.js';
import {
  hasImages,
  toMistralMessages,
  toMistralToolChoice,
  toMistralTools,
  toOpenAiCompletion,
} from './convert.js';
import { ERROR_KINDS, MistralError } from './mistral-api.js';

const logger = createLogger({ name: 'chat' });

export const CHAT_TIMEOUT_MS = 110_000;
export const ROUTER_TIMEOUT_MS = 18_000;

/**
 * @description The use counted for a purpose.
 * @param {string} purpose - The `purpose` of the request.
 * @returns {string} `router`, `digest` or `chat`.
 */
export function useOf(purpose) {
  if (purpose === AI_CHAT_PURPOSES.INTENT_CLASSIFICATION) {
    return 'router';
  }
  if (purpose === AI_CHAT_PURPOSES.WEEKLY_DIGEST) {
    return 'digest';
  }
  return 'chat';
}

/**
 * @description Build the Mistral request of a core request.
 * @param {object} request - `{ messages, tools?, tool_choice?, max_tokens?, purpose }`.
 * @param {object} config - The normalized config.
 * @param {Set<string>} [noReasoning] - Models that refused `reasoning_effort`.
 * @returns {object} The Mistral body.
 */
export function buildBody(request, config, noReasoning = new Set()) {
  const router = request?.purpose === AI_CHAT_PURPOSES.INTENT_CLASSIFICATION;
  const model = resolveModel(config, router ? 'fast_model' : 'model');
  if (!model) {
    throw new MistralError(
      ERROR_KINDS.MODEL,
      'The configuration chooses a custom model but the custom model id is empty',
    );
  }
  const body = {
    model,
    messages: toMistralMessages(request?.messages),
    // The caller's `max_tokens` is sized for an answer without reasoning.
    max_tokens: Math.min(
      MAX_TOKENS_MAX,
      Math.max(config.max_tokens, Number(request?.max_tokens) || 0),
    ),
  };
  const tools = toMistralTools(request?.tools);
  if (tools.length > 0) {
    body.tools = tools;
    const choice = toMistralToolChoice(request?.tool_choice);
    if (choice !== undefined) {
      body.tool_choice = choice;
    }
  }
  if (!noReasoning.has(model)) {
    const effort = reasoningEffortFor(model, router ? 'none' : config.reasoning);
    if (effort !== undefined) {
      body.reasoning_effort = effort;
    }
  }
  return body;
}

/**
 * @description Whether a refusal is about the `reasoning_effort` parameter.
 * @param {unknown} err - The error.
 * @returns {boolean} True for a 400/422 that names it.
 */
function refusedReasoning(err) {
  return (
    err instanceof MistralError &&
    err.kind === ERROR_KINDS.REQUEST &&
    /reasoning/i.test(err.message)
  );
}

/**
 * @description Create the `onAiChat` handler.
 * @param {object} options - Options.
 * @param {object} options.client - The Mistral client (mistral-api.js).
 * @param {() => object} options.getConfig - The normalized config.
 * @param {object} [options.usage] - The usage store (usage.js).
 * @param {(err: MistralError, context: object) => void} [options.onFailure] - Failure hook (scene trigger).
 * @param {() => void} [options.onSuccess] - Success hook.
 * @param {() => number} [options.now] - Clock.
 * @returns {(request: object) => Promise<object>} The handler.
 */
export function createChatHandler({
  client,
  getConfig,
  usage,
  onFailure = () => {},
  onSuccess = () => {},
  now = Date.now,
}) {
  // Models that refused `reasoning_effort` (a custom model without
  // reasoning): never sent to them again until the integration restarts.
  const noReasoning = new Set();

  return async function onAiChat(request) {
    const config = getConfig();
    const use = useOf(request?.purpose);
    const router = use === 'router';
    const started = now();
    let body;
    try {
      body = buildBody(request, config, noReasoning);
      let response;
      try {
        response = await client.chat(body, {
          timeoutMs: router ? ROUTER_TIMEOUT_MS : CHAT_TIMEOUT_MS,
        });
      } catch (err) {
        if (!('reasoning_effort' in body) || !refusedReasoning(err)) {
          throw err;
        }
        logger.warn(
          `${body.model} refused reasoning_effort=${body.reasoning_effort}: sent without it from now on`,
        );
        noReasoning.add(body.model);
        const { reasoning_effort: _dropped, ...rest } = body;
        body = rest;
        const left = (router ? ROUTER_TIMEOUT_MS : CHAT_TIMEOUT_MS) - (now() - started);
        response = await client.chat(body, { timeoutMs: Math.max(1000, left) });
      }
      const completion = toOpenAiCompletion(response);
      const message = completion.choices[0].message;
      const ms = now() - started;
      if (
        !message.content &&
        !message.tool_calls &&
        completion.choices[0].finish_reason === 'length'
      ) {
        throw new MistralError(
          ERROR_KINDS.REQUEST,
          `The answer was cut at max_tokens (${body.max_tokens}) before any text: raise it in the configuration`,
        );
      }
      if (completion.choices[0].finish_reason === 'length') {
        logger.warn(
          `The answer hit max_tokens (${body.max_tokens}): raise it in the configuration`,
        );
      }
      logger.info(
        `${request?.purpose ?? 'chat'}: ${modelName(body.model)} answered in ${(ms / 1000).toFixed(1)} s` +
          ` (${response?.usage?.prompt_tokens ?? '?'} in, ${response?.usage?.completion_tokens ?? '?'} out` +
          `${message.tool_calls ? `, ${message.tool_calls.length} tool call(s)` : ''})`,
      );
      usage?.recordSuccess({ use, model: body.model, usage: response?.usage, ms });
      onSuccess();
      return completion;
    } catch (err) {
      const error =
        err instanceof MistralError
          ? err
          : new MistralError(ERROR_KINDS.SERVER, err?.message ?? String(err));
      if (hasImages(request?.messages) && error.kind === ERROR_KINDS.REQUEST) {
        error.message += ' (the request carried an image: choose a model that reads images)';
      }
      logger.warn(`${request?.purpose ?? 'chat'} failed (${error.kind}): ${error.message}`);
      usage?.recordError({ use, model: body?.model, kind: error.kind, message: error.message });
      onFailure(error, { use, model: body?.model });
      throw error;
    }
  };
}
