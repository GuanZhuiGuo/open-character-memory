# Changelog

All notable changes are recorded here. The project follows semantic versioning while the public API remains pre-1.0.

## 0.4.1 - 2026-08-16

### Added

- NDJSON main-response streaming with sanitized GFM Markdown rendering and direct long-term-memory progress refresh.
- A 2026 comparison of application memory systems and coding-agent repository memory.

### Fixed

- Ark cache observability now preserves provider usage through the Pi adapter and defaults to provider-managed Responses caching; explicit Context caching remains opt-in for compatible endpoint IDs.
- Long-term extraction disables reasoning, allows complete structured output, and drains overdue conversations in configured eight-turn batches instead of retrying an ever-growing backlog.
- Event reconciliation prevents key collisions, converges same-topic update branches, ignores redundant same-message retractions, and closes stale meeting-attendance claims.
- Retrieval defaults are calibrated to `0.36 / 0.48 / 0.12`; high-fanout graph entities no longer force unrelated events into the main-model input.

## 0.4.0 - 2026-08-15

### Added

- Dynamic unlocked-capability runtime with validated declarative Skill ZIPs, the official MCP client, `tools/list` discovery, `tools/call` execution, approval gates, execution receipts, and Pi `toolResult` continuation turns.
- Tool-capable Ark/OpenAI/Anthropic streams, deterministic Mock tool calls, per-request model/tool limits, and MCP HTTP/stdio safety boundaries.
- Capability catalog and execution receipt persistence, plus end-to-end runtime tests for Skill and MCP execution.

### Changed

- Trace and the architecture view now render each ReAct model request, intervening Skill/MCP execution, `toolResult` handoff, limits, and final model continuation.
- Skill ZIP uploads are validated against a safe declarative package contract and never execute arbitrary packaged JavaScript or Python.

## 0.3.0 - 2026-08-15

### Added

- Pi Agent Core turn runtime with lifecycle events and a provider bridge that preserves Ark/OpenAI/Anthropic/Mock behavior and prefix caching.
- Bitemporal valid-time and transaction-time columns for structured memory history, events, claims, and entity relations, plus as-of event and graph queries.
- Neo4j current-graph projection, scope isolation, idempotent projection replacement, replayable SQLite outbox, health status, and SQLite retrieval fallback.
- Docker Compose Neo4j service and architecture documentation for runtime, temporal semantics, graph ownership, and deferred storage work.

### Changed

- The architecture UI now distinguishes Pi runtime, the SQLite source of truth, bitemporal state, and the Neo4j read projection.
- Trace now renders the concrete turn pipeline, Pi runtime/version, provider bridge, configured LLM, lifecycle timing, and the current automatic-tool-loop status before the raw spans.
- Docker builds now install locked runtime dependencies.

## 0.2.5 - 2026-08-15

### Added

- Stable/dynamic Prompt split and Ark `common_prefix` context caching with TTL, failure cooldown, and full-request fallback.
- Ark, OpenAI, Anthropic, and offline Mock text Provider adapters; independently selectable Embedding Provider.
- Cache usage metrics in Trace, including input tokens, cached tokens, cache status, and hit rate.
- Gender audience constraints for plot nodes so corrected identity state suppresses incompatible unlocked branches.
- Five-case memory regression evaluation suite and deterministic Provider tests.
- Apache-2.0 license, contribution/security policies, bilingual README, Docker/Compose, GitHub CI, and release preflight.
- PostgreSQL + pgvector staged migration guide.

### Changed

- Architecture view now distinguishes cacheable role prefixes from dynamic memory and uses Provider-neutral model labels.
- Production startup rejects missing, short, or example administrator passwords.

## 0.2.4 - 2026-08-14

- Added multi-branch role-play plots with gender-aware triggers and follow-up chapters.
- Added user registration, read-only user configuration/Trace access, feedback capture, and administrator user/feedback views.
- Added two-stage memory retrieval, graph evidence expansion, retrieval testing, and architecture code Q&A.
- Added configurable every-X-turn long-term memory extraction and event/entity/relation instructions.
