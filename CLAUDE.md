# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** that makes **Mistral AI** the AI
provider of a Gladys instance: a Node.js service (Node 22+, ESM, no build
step) in its own sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to the official Mistral API (La Plateforme, `https://api.mistral.ai/v1`)
with the administrator's API key. Runtime dependency: the SDK only (plain
`fetch`, no Mistral client). `type: "ai"`, Gladys 5.3.0+,
`transports: ["cloud"]`, `categories: ["assistants"]`. Not affiliated with
Mistral AI.

The contract (SDK README, "AI providers"): one OpenAI-compatible chat
completion in (`messages`, `tools`, `tool_choice`, `max_tokens`, `purpose`,
`categories`, no `model`), one OpenAI-compatible completion out. The agentic
loop (prompts, tools, history) runs in the core; this integration only picks
the model and translates. **Never tested with a real Mistral key**: request
and response shapes follow docs.mistral.ai and the official Python client
(`mistralai/client-python`, `docs/models`), checked on 2026-10-31.

## Commands

```bash
npm install
npm test                                  # node --test; a fake Mistral API on 127.0.0.1
node --test test/chat.test.js             # one file
UPDATE_BASELINE=1 npm test                # rewrite test/fixtures/manifest.baseline.json (on purpose only)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks
scripts/build-cover.sh                    # cover.jpg from docs/assets/cover.svg
docs/illustrations/render.sh              # docs/assets/widgets.<lang>.png
node .github/scripts/release.mjs next     # the version the next release would get
```

## Architecture

```
index.js               SDK wiring only (new GladysIntegration + createApp)
src/app.js             every handler: onAiChat, web search scene action, test button,
                       widget, configuration, status following the requests
src/chat.js            the AI provider: model per purpose, reasoning_effort, retry
                       without it when refused, cut answers, usage, hooks
src/convert.js         OpenAI <-> Mistral: tool call ids (9 alphanumerics), tool_choice,
                       thinking chunks dropped, arguments as JSON strings
src/mistral-api.js     fetch client: chat, conversations, models; deadline, retries on
                       429 / 5xx / network with Retry-After, error kinds
src/websearch.js       scene action: Conversations API + web_search, store false
src/events.js          triggers: error (once per failure kind), recovered
src/usage.js           /data/usage.json: requests and tokens per local day, 62 days
src/widgets.js         the usage widget
src/connection.js      status (GET /v1/models, no token spent) and the test button
src/config.js          models, reasoning per model, custom model id, max_tokens
src/i18n.js            runtime texts, en / fr / de / es
src/time.js            local days and times (TZ of Gladys, Intl only)
test/helpers/fake-mistral.js    the fake API (chat, conversations, models, 401 on a bad key)
.github/scripts/release.mjs     version, changelog, bump (tested in test/)
```

## Rules

- **Every key users store is forever**: the keys of `config_schema` and the
  values of the `model` / `fast_model` / `reasoning` selects (a model id leaves
  the list only when Mistral retires it), `actions`, the widget, the triggers
  (fields, options, variables), the scene action (fields, outputs).
  `test/structure.test.js` compares them to
  `test/fixtures/manifest.baseline.json`: never update it to make a test pass
  without a documented migration. A new scene action field is optional or has
  a default.
- **Deadlines of the core**: the ack is awaited 20 s for
  `intent-classification`, 120 s otherwise; the handler gives up at 18 s and
  110 s. Retries (429, 5xx, network) only while the deadline leaves room;
  a Retry-After longer than 8 s fails at once.
- **Never fall back silently**: a failure throws (the core names it to the
  user); never answer from another provider, never return an empty turn.
- **The router never reasons** (`reasoningEffortFor(model, 'none')`): it must
  answer fast. Only values a model accepts are sent (`MODELS[id].reasoning`).
- **The completion is bounded like the core does** (`validateAiCompletion`):
  `content` a string or null, at most 20 tool calls, names
  `^[a-zA-Z0-9_-]{1,64}$`, `arguments` a JSON string.
- **Scene events** once per transition: `error` when the failure kind changes,
  `recovered` at the first answer after. A refused request (`request` kind,
  HTTP 400/422) starts nothing and does not change the status.
- **The API key** is a `secret`: never logged, never in /data, never in an
  error message (`errorMessageOf` masks Bearer tokens).
- **The container rootfs is read-only.** Write only under `/data` (usage
  counters, written at most every 10 s and at shutdown).
- **Four languages.** Every user-facing text (manifest, `src/i18n.js`,
  `docs/*.md`, README) exists in en, fr, de, es; `test/i18n.test.js` checks it.
  German says "du", Spanish "usted".
- **Widget images.** After any change to a widget content, run
  `docs/illustrations/render.sh` again and look at the four PNG files.
- **No Mistral logo** in the cover or the docs: the name only says which
  service the integration talks to; keep the "not affiliated" notices.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
  Below 1.0.0 until the maintainer runs Release with `release-as: 1.0.0`.
- **Changelog.** Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Commits and PR titles** follow Conventional Commits, in English.
- **Forum drafts** (`.github/forum-*.md`) are never committed.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## Pitfalls

- Tool call ids: Mistral produces nine letters or digits and older models
  refuse others; the core may send `unknown` or ids of another provider. They
  are mapped with a hash, the same on the assistant turn and its tool result.
- Reasoning models (Large 4, Small 4 at `high`) answer `content` as a list:
  `thinking` chunks then `text` chunks. Only the text goes back.
- `tool_choice: "required"` is `"any"` for Mistral; tools and `tool_choice`
  are not sent when the core gives no tool.
- Mistral Large 4 accepts `reasoning_effort` low / medium / high (never
  `none`); Small 4 accepts `none` / `high`; Ministral refuses it.
- `AbortSignal.timeout` does not keep the process alive: a test that waits on
  it needs its own timer.
- `node --test` also runs `test/helpers/`: nothing starts on import.
- The validator of the Gladys core creates `gladys-development.duckdb` in the
  current folder: run it from elsewhere.
