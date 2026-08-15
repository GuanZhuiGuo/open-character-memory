# Changelog

All notable changes are recorded here. The project follows semantic versioning while the public API remains pre-1.0.

## 0.3.0 - Unreleased

### Added

- Pi Agent Core turn runtime with lifecycle events and a provider bridge that preserves Ark/OpenAI/Anthropic/Mock behavior and prefix caching.
- Bitemporal valid-time and transaction-time columns for structured memory history, events, claims, and entity relations, plus as-of event and graph queries.
- Neo4j current-graph projection, scope isolation, idempotent projection replacement, replayable SQLite outbox, health status, and SQLite retrieval fallback.
- Docker Compose Neo4j service and architecture documentation for runtime, temporal semantics, graph ownership, and deferred storage work.

### Changed

- The architecture UI now distinguishes Pi runtime, the SQLite source of truth, bitemporal state, and the Neo4j read projection.
- Docker builds now install locked runtime dependencies.

## 0.2.5 - Unreleased

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
