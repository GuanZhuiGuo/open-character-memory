# Memory Agent Studio

Memory Agent Studio is a runnable memory workbench for role-play companions and tutoring agents. It separates durable controls, structured state, event/claim history, graph evidence, short-term dialogue, and retrieval so that a model does not treat every semantically similar memory as current truth.

Version `0.3.0` runs main turns through Pi Agent Core, stores bitemporal records in SQLite as the current source of truth, and projects the current graph to Neo4j through a replayable outbox.

## What is implemented

- Hard isolation by user, agent, story, and branch.
- Admin-defined structured memory fields with types, scopes, constraints, extraction instructions, and prompt templates.
- User-defined persistent response rules that pass server-side safety boundaries.
- Versioned claims with `active`, `superseded`, and `retracted` states.
- Bitemporal `valid_*` and `transaction_*` intervals with `valid_at` / `known_at` as-of queries.
- Neo4j graph projection with tenant scope keys, idempotent replacement, outbox replay, and SQLite fallback.
- Pi Agent Core state and lifecycle events while preserving the existing provider, prompt, trace, retrieval, plot, and prop pipeline.
- User memory plus role/user shared-story events, entities, claims, and evidence-backed relations.
- Two-stage retrieval: a lightweight candidate catalog followed by planner-selected detail and graph expansion.
- Conditional story unlocking and auditable function calls driven by structured state.
- Role prompt, memory injection, retrieval, model usage, and cache diagnostics in Trace.
- Provider adapters for Ark, OpenAI, Anthropic, and an offline Mock mode.
- Stable-prefix caching: role instructions and fixed attributes are cacheable; user state, retrieved memory, plots, and recent dialogue stay dynamic.

## Quick start

Node.js 24 or later is required.

```bash
npm ci
npm run start:mock
```

Open `http://127.0.0.1:4173`. Mock mode requires no external account and uses `local-demo-admin-2026` as a local-only administrator password.

For a real provider:

```bash
cp .env.example .env.local
# Set TEXT_PROVIDER, EMBEDDING_PROVIDER, provider credentials, and a strong ADMIN_PASSWORD.
npm start
```

Docker Compose deliberately requires an explicit administrator password:

```bash
ADMIN_PASSWORD='replace-with-a-strong-secret' \
NEO4J_PASSWORD='replace-with-a-different-strong-secret' \
docker compose up --build
```

## Verification

```bash
npm test
npm run eval
npm run check:open-source
```

Tests and memory evaluations run without external model calls.

## Cache boundary

The database, state machine, and prompt compiler remain the only source of truth. The cache stores only a provider context identifier for the stable prompt prefix. Its key contains the provider/model, agent, profile version, scene configuration version, and stable prompt hash. Any profile edit creates a new key. Cache failure falls back to a complete uncached request and never changes memory correctness.

Ark uses the explicit `common_prefix` Context API when enabled. OpenAI reports provider-managed cached token usage. Anthropic marks the stable system block as ephemeral cache content. Trace reports provider, input tokens, cached tokens, status, and hit rate.

## Storage boundary

SQLite is the current single-node source of truth. Neo4j is a rebuildable read projection for graph traversal, not a second authority. Embeddings remain JSON vectors scored in the application process. The SDK and PostgreSQL plus pgvector migration are deliberately deferred and documented as future work.

OpenSearch may become useful later as a hybrid lexical/vector retrieval index for large corpora, but it should not replace the transactional record or Neo4j path projection.

See [the runtime and graph design](docs/bitemporal-neo4j-pi-runtime.md), [the future storage roadmap](docs/future-storage-sdk-roadmap.md), and [the release checklist](docs/open-source-release-checklist.md).

## License

Apache License 2.0.
