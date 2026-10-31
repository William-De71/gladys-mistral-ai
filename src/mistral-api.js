// -----------------------------------------------------------------------------
// Client of the Mistral API (La Plateforme, https://api.mistral.ai/v1).
//
// Plain fetch, no SDK: three endpoints only —
//   - POST /v1/chat/completions   the assistant (OpenAI-shaped, see convert.js)
//   - POST /v1/conversations      the web search scene action (built-in tool)
//   - GET  /v1/models/{id}        the connection check (spends no token)
//
// Every call runs under a deadline. A 429 (the free Experiment plan allows
// about one request per second) or a 5xx is retried while the deadline leaves
// room for it, honouring Retry-After; anything else fails at once with a
// MistralError that says what went wrong without echoing the key.
// -----------------------------------------------------------------------------

export const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

/** The error kinds, also the `kind` variable of the `error` scene trigger. */
export const ERROR_KINDS = {
  AUTH: 'auth',
  MODEL: 'model',
  RATE_LIMIT: 'rate_limit',
  REQUEST: 'request',
  SERVER: 'server',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
};

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
const MAX_ATTEMPTS = 3;

export class MistralError extends Error {
  /**
   * @param {string} kind - One of ERROR_KINDS.
   * @param {string} message - What went wrong (never the key).
   * @param {object} [details] - `{ status, retryAfterMs }`.
   */
  constructor(kind, message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'MistralError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @description The kind of an HTTP failure.
 * @param {number} status - The HTTP status.
 * @returns {string} One of ERROR_KINDS.
 */
export function kindOfStatus(status) {
  if (status === 401 || status === 403) {
    return ERROR_KINDS.AUTH;
  }
  if (status === 404) {
    return ERROR_KINDS.MODEL;
  }
  if (status === 429) {
    return ERROR_KINDS.RATE_LIMIT;
  }
  if (status >= 500) {
    return ERROR_KINDS.SERVER;
  }
  return ERROR_KINDS.REQUEST;
}

/**
 * @description The message of an error body, short and without secrets.
 * @param {unknown} body - The parsed body, or the raw text.
 * @returns {string} The message.
 */
export function errorMessageOf(body) {
  let message = '';
  if (typeof body === 'string') {
    message = body;
  } else if (body && typeof body === 'object') {
    const candidate = body.message ?? body.detail ?? body.error?.message ?? body.error;
    if (typeof candidate === 'string') {
      message = candidate;
    } else if (Array.isArray(candidate)) {
      // FastAPI-style validation details: [{ loc, msg }]
      message = candidate
        .map((item) =>
          [Array.isArray(item?.loc) ? item.loc.join('.') : '', item?.msg]
            .filter(Boolean)
            .join(': '),
        )
        .join('; ');
    } else if (candidate !== undefined) {
      message = JSON.stringify(candidate);
    }
  }
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * @description Milliseconds asked by a Retry-After header.
 * @param {string|null} value - The header.
 * @param {number} now - Now (ms).
 * @returns {number|null} Milliseconds, null when absent or unreadable.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @description Build a client.
 * @param {object} options - Options.
 * @param {() => string} options.getApiKey - The current API key.
 * @param {string} [options.baseUrl] - The API root (tests point it to a fake).
 * @param {typeof fetch} [options.fetchImpl] - fetch.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waiting (tests skip it).
 * @param {() => number} [options.now] - Clock.
 * @returns {object} `{ chat, conversation, retrieveModel }`.
 */
export function createMistralClient({
  getApiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const root = baseUrl.replace(/\/+$/, '');

  /**
   * @description One HTTP call, retried on 429 / 5xx / network while the
   * deadline allows.
   * @param {string} method - GET or POST.
   * @param {string} path - Path under /v1.
   * @param {object} [options] - `{ body, timeoutMs, retries }`.
   * @returns {Promise<object>} The parsed JSON body.
   */
  async function request(method, path, { body, timeoutMs = 30_000, retries = true } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new MistralError(ERROR_KINDS.AUTH, 'No Mistral API key in the configuration');
    }
    const deadline = now() + timeoutMs;
    let lastError = null;
    for (let attempt = 1; attempt <= (retries ? MAX_ATTEMPTS : 1); attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        break;
      }
      try {
        return await once(method, path, body, apiKey, remaining);
      } catch (err) {
        lastError = err;
        const retryable =
          err.kind === ERROR_KINDS.RATE_LIMIT ||
          err.kind === ERROR_KINDS.SERVER ||
          err.kind === ERROR_KINDS.UNREACHABLE;
        if (!retryable || !retries || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        const wait = err.retryAfterMs ?? RETRY_BASE_MS * 2 ** (attempt - 1);
        // A long wait asked by Mistral, or no room left for the wait and a
        // useful answer: fail now, with the real reason, rather than later
        // with a timeout.
        if (wait > RETRY_MAX_MS || now() + wait + 1000 >= deadline) {
          throw err;
        }
        await sleep(wait);
      }
    }
    throw (
      lastError ??
      new MistralError(ERROR_KINDS.TIMEOUT, `No answer within ${Math.round(timeoutMs / 1000)} s`)
    );
  }

  async function once(method, path, body, apiKey, timeoutMs) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new MistralError(
          ERROR_KINDS.TIMEOUT,
          `No answer within ${Math.round(timeoutMs / 1000)} s`,
        );
      }
      throw new MistralError(
        ERROR_KINDS.UNREACHABLE,
        `Cannot reach the Mistral API (${err?.cause?.code ?? err?.message ?? 'network error'})`,
      );
    }
    const text = await response.text().catch(() => '');
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message = errorMessageOf(parsed ?? text) || response.statusText || 'error';
      throw new MistralError(kindOfStatus(response.status), `HTTP ${response.status}: ${message}`, {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
      });
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new MistralError(
        ERROR_KINDS.SERVER,
        'The Mistral API answered something that is not JSON',
        {
          status: response.status,
        },
      );
    }
    return parsed;
  }

  return {
    /**
     * @description POST /v1/chat/completions.
     * @param {object} body - A Mistral chat completion request.
     * @param {object} [options] - `{ timeoutMs, retries }`.
     * @returns {Promise<object>} The completion.
     */
    chat(body, options) {
      return request('POST', '/chat/completions', { ...options, body });
    },
    /**
     * @description POST /v1/conversations (built-in tools such as web_search).
     * @param {object} body - A conversation request.
     * @param {object} [options] - `{ timeoutMs, retries }`.
     * @returns {Promise<object>} The conversation response.
     */
    conversation(body, options) {
      return request('POST', '/conversations', { ...options, body });
    },
    /**
     * @description GET /v1/models/{id}: is this model open to the key?
     * @param {string} id - The model id.
     * @param {object} [options] - `{ timeoutMs }`.
     * @returns {Promise<object>} The model card (capabilities included).
     */
    retrieveModel(id, options) {
      return request('GET', `/models/${encodeURIComponent(id)}`, {
        timeoutMs: 15_000,
        ...options,
        retries: false,
      });
    },
  };
}
