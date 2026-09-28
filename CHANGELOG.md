# Changelog

Notable Firebreak changes are recorded here. Recordings remain the source of truth for match outcomes; implementation changes do not rewrite historical SQLite files.

## 2026-09-28

### Added

- Added the local `chat-mentions` communication condition, where only explicitly named agents receive a message.
- Added the local `chat-broadcast` condition, where every agent receives every room message and mentions identify intended readers.
- Added the OpenAI Responses API backend and model/cost accounting for OpenAI matches.
- Added the `codex` subscription backend using a headless Codex App Server and the local ChatGPT login.
- Added an omniscient post-match commentator for every communication condition.
- Added saved, versioned commentary sidecars under `runs/commentary/` so historical broadcasts are generated once and reused.
- Added automatic commentary generation for historical replays that do not already have saved commentary.
- Added a full broadcast transcript reader, viewer legend, rules reference, and labelled timeline markers.
- Added per-team mission-outcome counters and an outcome-over-time replay chart with metric and communication-style toggles.
- Added paired advanced-model comparison notes and reports for Claude and OpenAI runs.
- Added a replay-visible sub-agent lifecycle configurator that produces the exact next-run override.
- Added persistent View controls for mission stats, operational stats, team messages, AI commentary, and the comparison chart.

### Changed

- Reworked broadcast text into connected, human-readable incident commentary without coordinates, internal IDs, tick numbers, or simulation jargon.
- Moved replay commentary loading into the background so refreshing a replay does not repeatedly block on generation.
- Made local Claude/Haiku the default replay commentator, independently of the gameplay model.
- Documented that displayed subscription dollar figures are API-equivalent estimates rather than billed charges.
- Documented the scoring information agents receive and the requirements for a valid cross-run comparison.
- Made sub-agents task-lived by default: they retain one assignment, accumulated sightings, and order history until they report completion or blockage. The former eight-tick cutoff remains an opt-in setting.
- Added total/current/remaining tick information to every gameplay agent's system instructions and clarified the visibility, spread risk, and response priority of fire intensity.
- Replaced the narrow “missed joint” counter with uncovered intensity-3 fire-ticks, which includes ignored and singly assigned joint fires.
- Reworked the replay grid to size boards from available width instead of fixed panel-height estimates, and made statistic labels wrap into responsive three- or six-column layouts.

### Fairness and security

- Every world inside a match shares one seed, scenario, event schedule, engine rules, and model configuration. Peer-agent communication teams also share the same base prompt and decision loop; the separately labelled sub-agent condition intentionally replaces the peer topology with its recorded orchestrator/worker lifecycle.
- Codex uses one process per match for transport efficiency but a fresh ephemeral thread for every decision, matching the stateless decision boundary of the other backends.
- Codex user configuration, stored conversations, AGENTS files, MCP servers, skills, plugins, apps, shell tools, web search, and native subagents are excluded from Firebreak decisions.
- The Codex backend verifies ChatGPT authentication and removes `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` from its subprocess.
- The Claude subscription backend removes `ANTHROPIC_API_KEY` from its subprocess.
- `.env` and Band credentials remain git-ignored, and recordings redact secret-looking configuration values.

### Verification

- Added offline protocol tests for Codex dynamic game-tool calls, token accounting, ephemeral threads, and shutdown.
- Verified one-tick subscription smoke recordings for both Codex/GPT-5.6-Luna and Claude/Haiku without API keys.
- Verified the generated recordings by replaying their recorded orders through the deterministic engine.

## 2026-09-27

### Initial implementation

- Added the deterministic wildfire engine, seeded scenario generation, agent observations, orders, scoring, and scripted bots.
- Added SQLite recording, deterministic verification, metrics, batch reports, replay/export support, and the multi-board viewer.
- Added the Claude API and Claude subscription backends.
- Added the no-communication, perfect-information, Band, and ephemeral sub-agent team conditions.
- Added curated recordings and initial tuning/showcase results.
