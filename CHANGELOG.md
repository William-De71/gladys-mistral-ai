# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - 2026-10-31

### Added

- **ai:** the Gladys AI provider on Mistral AI (La Plateforme), with the administrator's own API key: the chat and its tool calls, the intent router, the scene "ask the AI" action and the weekly digest
- **models:** Mistral Large 4, Mistral Small 4 and the Ministral 3 models (14B, 8B, 3B), or any other model id of La Plateforme; a chat model and a fast router model; reasoning level for the chat model
- **scenes:** "ask with web search" action (Mistral's built-in web search, answer and sources as outputs); triggers when the assistant fails (key refused, rate limit, model unavailable, API unreachable) and when it answers again
- **widgets:** requests and tokens of the day and of the month, tokens per day over 30 days, last answer and last error
- **configuration:** "Test the connection" button; connection status checked without spending tokens
- **i18n:** English, French, German and Spanish for the manifest, the runtime texts, the documentation and the README

[0.1.0]: https://github.com/William-De71/gladys-mistral-ai/releases/tag/v0.1.0
