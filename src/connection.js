// -----------------------------------------------------------------------------
// Connection status and the "Test the connection" action.
//
// The status shown in the Configuration screen says whether Mistral can
// answer: a key is there, Mistral accepts it, and both chosen models are open
// to it and can call tools (the assistant drives Gladys through tools).
// Reading a model card (GET /v1/models/{id}) proves it without spending a
// token; only the test action spends a few, on purpose, to show a real answer
// and its time.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { modelName, reasoningEffortFor, resolveModel } from './config.js';
import { ERROR_KINDS, MistralError } from './mistral-api.js';
import { all, t } from './i18n.js';

const logger = createLogger({ name: 'connection' });

const TEST_TIMEOUT_MS = 25_000;
const ROLES = [
  ['chat', 'model'],
  ['router', 'fast_model'],
];

/**
 * @description The localized reason of a failure.
 * @param {unknown} err - The error.
 * @param {string} model - The model concerned.
 * @returns {object} `{ en, fr, de, es }`.
 */
export function failureMessage(err, model) {
  const kind = err instanceof MistralError ? err.kind : ERROR_KINDS.SERVER;
  const name = modelName(model);
  switch (kind) {
    case ERROR_KINDS.AUTH:
      return all('statusBadKey');
    case ERROR_KINDS.MODEL:
      return all('statusNoModel', { model: name });
    case ERROR_KINDS.RATE_LIMIT:
      return all('statusRateLimited');
    case ERROR_KINDS.UNREACHABLE:
    case ERROR_KINDS.TIMEOUT:
      return all('statusUnreachable');
    default:
      return all('statusApiError', { detail: err?.message ?? String(err) });
  }
}

/**
 * @description Check the configuration against the Mistral API, without
 * generating text.
 * @param {object} client - The Mistral client.
 * @param {object} config - The normalized config.
 * @returns {Promise<{ ok: boolean, message?: object, warnings: Array<object> }>} The result.
 */
export async function checkConnection(client, config) {
  if (!config.api_key) {
    return { ok: false, message: all('statusNoKey'), warnings: [] };
  }
  const warnings = [];
  for (const [, key] of ROLES) {
    const model = resolveModel(config, key);
    if (!model) {
      return { ok: false, message: all('statusNoCustom'), warnings };
    }
  }
  for (const model of new Set(ROLES.map(([, key]) => resolveModel(config, key)))) {
    try {
      const card = await client.retrieveModel(model);
      if (card?.capabilities && card.capabilities.function_calling === false) {
        warnings.push(all('statusNoTools', { model: modelName(model) }));
      }
    } catch (err) {
      logger.warn(`Connection check failed for ${model}: ${err?.message ?? err}`);
      return { ok: false, message: failureMessage(err, model), warnings };
    }
  }
  return { ok: true, warnings };
}

/**
 * @description The "Test the connection" action: one tiny real answer from
 * each model.
 * @param {object} client - The Mistral client.
 * @param {object} config - The normalized config.
 * @param {() => number} [now] - Clock.
 * @returns {Promise<object>} The message shown under the button, `{ en, fr, de, es }`.
 */
export async function testConnection(client, config, now = Date.now) {
  if (!config.api_key) {
    return all('statusNoKey');
  }
  const lines = [];
  const tested = new Map();
  for (const [role, key] of ROLES) {
    const model = resolveModel(config, key);
    if (!model) {
      lines.push((language) => `${t(`role_${role}`, language)} — ${t('statusNoCustom', language)}`);
      continue;
    }
    if (tested.has(model)) {
      const same = tested.get(model);
      lines.push((language) => `${t(`role_${role}`, language)} — ${same(language)}`);
      continue;
    }
    const started = now();
    let line;
    try {
      const effort = reasoningEffortFor(model, 'none');
      await client.chat(
        {
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          ...(effort ? { reasoning_effort: effort } : {}),
        },
        { timeoutMs: TEST_TIMEOUT_MS, retries: false },
      );
      const seconds = (now() - started) / 1000;
      line = (language) =>
        t('testAnswered', language, {
          model: modelName(model),
          seconds: seconds.toLocaleString(language, { maximumFractionDigits: 1 }),
        });
    } catch (err) {
      logger.warn(`Test of ${model} failed: ${err?.message ?? err}`);
      const reason = failureMessage(err, model);
      line = (language) => reason[language];
    }
    tested.set(model, line);
    lines.push((language) => `${t(`role_${role}`, language)} — ${line(language)}`);
  }
  return all((language) => lines.map((line) => line(language)).join('\n'));
}
