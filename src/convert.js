// -----------------------------------------------------------------------------
// OpenAI-shaped requests of the Gladys core <-> Mistral chat completions.
//
// Mistral speaks almost the same dialect; the differences handled here:
//   - tool call ids: Mistral produces (and older models require) ids of nine
//     letters or digits. The core may send others (`unknown`, a history made
//     by another provider): each one is mapped to a stable nine-character id,
//     the same on the assistant turn and on its tool result.
//   - `tool_choice: "required"` is spelled `"any"` by Mistral.
//   - reasoning models answer `content` as a list of chunks (`thinking`, then
//     `text`): only the text goes back to the core, which wants a string.
//   - `arguments` may come back as an object: the core wants a JSON string.
//   - only the fields Mistral knows are sent (no `name` on user messages, no
//     `refusal`, no `strict` on tools it would not expect).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const MISTRAL_TOOL_ID = /^[a-zA-Z0-9]{9}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** The bounds the core applies to a completion (validateAiCompletion). */
const MAX_TOOL_CALLS = 20;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * @description A tool call id Mistral accepts: kept when it already is one,
 * else nine characters derived from it (stable, so the assistant turn and its
 * tool result keep matching).
 * @param {unknown} id - The id of the core.
 * @returns {string} Nine letters or digits.
 */
export function toMistralToolId(id) {
  const value = id === undefined || id === null ? 'unknown' : String(id);
  if (MISTRAL_TOOL_ID.test(value)) {
    return value;
  }
  const digest = createHash('sha256').update(value).digest();
  let out = '';
  for (let i = 0; i < 9; i += 1) {
    out += ALPHABET[digest[i] % ALPHABET.length];
  }
  return out;
}

/**
 * @description The text of a content (string or list of parts).
 * @param {unknown} content - An OpenAI or Mistral content.
 * @returns {string} The text parts joined.
 */
export function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

/**
 * @description The parts of a user message Mistral reads: text and images.
 * @param {unknown} content - The OpenAI content.
 * @returns {string|Array<object>} A string, or text / image_url chunks.
 */
function userContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
    } else if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url === 'string' && url) {
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return parts.every((part) => part.type === 'text')
    ? parts.map((part) => part.text).join('\n')
    : parts;
}

/**
 * @description Whether a request carries an image.
 * @param {Array<object>} messages - OpenAI messages.
 * @returns {boolean} True when a user message has an image part.
 */
export function hasImages(messages) {
  return (messages ?? []).some(
    (message) =>
      Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url'),
  );
}

/**
 * @description The arguments of a tool call as the JSON string the core wants.
 * @param {unknown} value - A string or an object.
 * @returns {string} JSON.
 */
function argumentsString(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? {});
}

/**
 * @description OpenAI messages -> Mistral messages.
 * @param {Array<object>} messages - The messages of the core.
 * @returns {Array<object>} The Mistral messages.
 */
export function toMistralMessages(messages) {
  const out = [];
  for (const message of messages ?? []) {
    switch (message?.role) {
      case 'system':
      case 'developer':
        out.push({ role: 'system', content: textOf(message.content) });
        break;
      case 'user':
        out.push({ role: 'user', content: userContent(message.content) });
        break;
      case 'assistant': {
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const text = textOf(message.content);
        const turn = { role: 'assistant' };
        if (text || toolCalls.length === 0) {
          turn.content = text;
        }
        if (toolCalls.length > 0) {
          turn.tool_calls = toolCalls.map((call) => ({
            id: toMistralToolId(call?.id),
            type: 'function',
            function: {
              name: String(call?.function?.name ?? ''),
              arguments: argumentsString(call?.function?.arguments),
            },
          }));
        }
        out.push(turn);
        break;
      }
      case 'tool': {
        const turn = {
          role: 'tool',
          tool_call_id: toMistralToolId(message.tool_call_id),
          content: typeof message.content === 'string' ? message.content : textOf(message.content),
        };
        if (typeof message.name === 'string' && message.name) {
          turn.name = message.name;
        }
        out.push(turn);
        break;
      }
      default:
        // An unknown role is dropped: Mistral would refuse the whole request.
        break;
    }
  }
  return out;
}

/**
 * @description OpenAI tools -> Mistral tools (same shape, known keys only).
 * @param {Array<object>} tools - The tools of the core.
 * @returns {Array<object>} The tools.
 */
export function toMistralTools(tools) {
  return (tools ?? [])
    .filter((tool) => tool?.type === 'function' && typeof tool.function?.name === 'string')
    .map((tool) => {
      const fn = {
        name: tool.function.name,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      };
      if (typeof tool.function.description === 'string') {
        fn.description = tool.function.description;
      }
      return { type: 'function', function: fn };
    });
}

/**
 * @description OpenAI tool_choice -> Mistral tool_choice.
 * @param {unknown} choice - `auto`, `none`, `required` or `{ type, function }`.
 * @returns {string|object|undefined} The value to send, undefined for none.
 */
export function toMistralToolChoice(choice) {
  if (choice === 'required' || choice === 'any') {
    return 'any';
  }
  if (choice === 'auto' || choice === 'none') {
    return choice;
  }
  if (choice && typeof choice === 'object' && typeof choice.function?.name === 'string') {
    return { type: 'function', function: { name: choice.function.name } };
  }
  return undefined;
}

/**
 * @description A Mistral completion -> the OpenAI completion the core reads.
 * @param {object} response - The Mistral chat completion.
 * @returns {object} `{ id, object, model, choices: [{ message, finish_reason }], usage }`.
 */
export function toOpenAiCompletion(response) {
  const choice = response?.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter((call) => TOOL_NAME.test(String(call?.function?.name ?? '')))
    .slice(0, MAX_TOOL_CALLS)
    .map((call, index) => ({
      id:
        typeof call.id === 'string' && call.id
          ? call.id
          : toMistralToolId(`${response?.id ?? 'call'}-${index}`),
      type: 'function',
      function: { name: call.function.name, arguments: argumentsString(call.function.arguments) },
    }));
  const text = textOf(message.content);
  const out = {
    role: 'assistant',
    content: text || (toolCalls.length > 0 ? null : ''),
  };
  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls;
  }
  return {
    id: response?.id,
    object: 'chat.completion',
    model: response?.model,
    choices: [{ index: 0, message: out, finish_reason: choice?.finish_reason ?? 'stop' }],
    usage: response?.usage,
  };
}
