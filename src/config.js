// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the administrator in Gladys from the `config_schema` of the
// manifest; the SDK fetches it (`gladys.getConfig()`) and notifies every
// change (`gladys.onConfigUpdated()`). This module provides the defaults and
// normalizes what arrives, so the rest of the code never deals with
// `undefined`, a number typed as a string, or a model the select no longer
// offers.
// -----------------------------------------------------------------------------

/**
 * The Mistral models offered in the Configuration screen. The ids are the
 * exact API ids of La Plateforme (docs.mistral.ai, checked 2026-10-31): they
 * are stored by users, so an id leaves this list only when Mistral retires the
 * model. `custom` hands the choice to the free `custom_model` field.
 *
 * `reasoning`: the `reasoning_effort` values the model accepts —
 *   - Mistral Large 4: low / medium / high (no way to turn it off);
 *   - Mistral Small 4: none / high;
 *   - Ministral 3: no reasoning, the parameter is not sent.
 */
export const MODELS = {
  'mistral-large-4': { name: 'Mistral Large 4', reasoning: ['low', 'medium', 'high'] },
  'mistral-small-latest': { name: 'Mistral Small 4', reasoning: ['none', 'high'] },
  'ministral-14b-latest': { name: 'Ministral 3 14B', reasoning: [] },
  'ministral-8b-latest': { name: 'Ministral 3 8B', reasoning: [] },
  'ministral-3b-latest': { name: 'Ministral 3 3B', reasoning: [] },
};

export const CUSTOM_MODEL = 'custom';

/** The reasoning levels of the configuration (`reasoning` select). */
export const REASONING_LEVELS = ['none', 'low', 'medium', 'high'];

/** A model id typed by hand: what La Plateforme ids look like. */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/;

/** Bounds of the `max_tokens` field, mirrored by the manifest. */
export const MAX_TOKENS_MIN = 1024;
export const MAX_TOKENS_MAX = 32000;

// Defaults: they MUST stay consistent with the `default` values declared in
// the `config_schema` of the manifest (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  // The Mistral API key. A `secret` field: no default, never logged.
  api_key: '',
  // The model of the chat, the scene `ai.ask` action, the weekly digest and
  // the web search action.
  model: 'mistral-large-4',
  // The model of the intent router, which runs before every chat turn and must
  // answer within 20 s: a fast, cheap model is the right one there.
  fast_model: 'ministral-8b-latest',
  // The id used by a select set to "custom" (a fine-tune, a newer model…).
  custom_model: '',
  // How hard the chat model thinks, when it can.
  reasoning: 'medium',
  // Output budget of one answer (reasoning included).
  max_tokens: 8000,
};

/**
 * @description Merge the user config with the defaults.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized config.
 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  const customModel = String(config.custom_model ?? '').trim();
  return {
    api_key: String(config.api_key ?? '').trim(),
    model: pickModel(config.model, DEFAULT_CONFIG.model),
    fast_model: pickModel(config.fast_model, DEFAULT_CONFIG.fast_model),
    custom_model: MODEL_ID_PATTERN.test(customModel) ? customModel : '',
    reasoning: REASONING_LEVELS.includes(config.reasoning)
      ? config.reasoning
      : DEFAULT_CONFIG.reasoning,
    max_tokens: clampInteger(config.max_tokens, MAX_TOKENS_MIN, MAX_TOKENS_MAX),
  };
}

/**
 * @description The model id to call for a select value.
 * @param {object} config - The normalized config.
 * @param {'model'|'fast_model'} key - Which select.
 * @returns {string|null} The API model id, null when "custom" has no id.
 */
export function resolveModel(config, key) {
  const value = config[key];
  if (value === CUSTOM_MODEL) {
    return config.custom_model || null;
  }
  return value;
}

/**
 * @description The display name of a model id.
 * @param {string} id - An API model id.
 * @returns {string} "Mistral Large 4", or the id itself.
 */
export function modelName(id) {
  return MODELS[id]?.name ?? id;
}

/**
 * @description The `reasoning_effort` to send for a model.
 * @param {string} id - The API model id.
 * @param {string} level - The wanted level (`none`, `low`, `medium`, `high`).
 * @returns {string|undefined} The value to send, undefined to send nothing.
 */
export function reasoningEffortFor(id, level) {
  const accepted = MODELS[id]?.reasoning;
  if (!accepted) {
    // A custom model: send the level as asked, except "none" by default
    // (most models without reasoning refuse the parameter). A refusal is
    // caught by the chat handler, which retries without it.
    return level === 'none' ? undefined : level;
  }
  if (accepted.length === 0) {
    return undefined;
  }
  if (accepted.includes(level)) {
    return level;
  }
  // Closest accepted value: Small 4 knows only none and high, Large 4 cannot
  // be turned off.
  if (level === 'none') {
    return accepted[0];
  }
  return accepted.includes('high') && level !== 'low' ? 'high' : accepted[0];
}

/**
 * @description A select value kept when known, else the default.
 * @param {unknown} value - The value.
 * @param {string} fallback - The default.
 * @returns {string} A model key or "custom".
 */
function pickModel(value, fallback) {
  if (value === CUSTOM_MODEL || (typeof value === 'string' && value in MODELS)) {
    return value;
  }
  return fallback;
}

/**
 * @description An integer within bounds.
 * @param {unknown} value - The value.
 * @param {number} min - The minimum.
 * @param {number} max - The maximum.
 * @returns {number} The integer.
 */
function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) {
    return DEFAULT_CONFIG.max_tokens;
  }
  return Math.min(max, Math.max(min, number));
}
