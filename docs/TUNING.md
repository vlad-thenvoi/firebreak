# Tuning notes

Measurements behind the defaults in `packages/engine/src/config.ts` and `packages/runtime/src/config.ts`. Dates are 2026-09-27; model `claude-haiku-4-5-20251001`, backend `claude-code` unless noted.

## 1. Game rules (scripted bots)

`packages/cli/scripts/bot-tune.ts` plays `bots-none` (own vision only) against `bots-perfect` (union vision) on 30 seeds per setting. The bots are dumb on purpose; the question is only whether shared information pays.

| spread | growth every | civilian deadline | none | perfect |
|---|---|---|---|---|
| 0.08 | 4 | 12 | −22 | +14 |
| 0.05 | 6 | 16 | −3 | +36 |
| 0.035 | 6 | 16 | −3 | +38 |

Chosen: `base_spread 0.05`, `growth_every 5`, `civilian_deadline 15`, and the rescuer drives at 2 tiles/tick (at 1 tile/tick almost every civilian was lost even with perfect information). Fires still escalate if ignored, and information clearly matters.

## 2. LLM latency on the `claude-code` backend

| Change | Mean decision latency | Mean input tokens |
|---|---|---|
| First version, one `query()` per decision | 14–21 s (max 43 s) | 3k, but some calls ~85k |
| Pre-started ("warm") streaming sessions | ~4.7 s | 82k on every call (reverted) |
| Return on the tool result instead of waiting for the subprocess to exit | ~2 s saved per call | — |
| `thinking: { type: "disabled" }` | **~4 s** | 19–30k |
| `strictMcpConfig: true` (don't load the account's claude.ai connectors) | ~4 s | **~3k** |

Concurrency is not the bottleneck: 10 parallel trivial calls take ~3.4 s, 20 take 4–9 s. A 5 s tick fits.

## 3. Agent competence (prompt version 2)

First full match (seed 5, four teams): `none −52`, `perfect −54`, `band −54`, `subagents +7`. All the difference was two civilians the sub-agents happened to reach. The replays showed why the other teams failed:

- firefighters on `wait()` with fires in view,
- the rescuer retrying `move_to` behind debris after a bare `no_path`,
- many `move_to` orders onto water or houses (coordinate misreads), each costing a retry turn.

Fixes, identical for every team:

- `move_to` onto an impossible tile is redirected to the nearest reachable tile (SPEC §4.3).
- Blocked orders explain themselves: `no_path: debris at (17,6) blocks the way; the engineer can clear it`.
- Role playbooks in the system prompt (target orders walk there by themselves; don't wait when there is work; pair up on intensity-3 fires; debris the rescuer needs comes first).
- The map header shows two-digit column numbers.

After the fixes, seed 5 over 30 ticks: `none −60`, `perfect +3`. The reference gap exists.

## 4. Batch 1: seeds 11–13, prompt v2

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | −80 | 17 | 12 | −50 |
| 12 | −1 | 49 | −34 | −9 |
| 13 | −52 | 7 | −47 | −50 |
| **mean** | **−44** | **+24** | **−23** | **−36** |

- The reference gap holds on every seed (perfect − none ≈ 68 points on average), so the game rewards information. That was the M5 gate.
- Band averaged ahead of sub-agents but far below perfect. Its metrics showed why: 2–3× more idle agent-ticks than perfect, and **about 30% of Band decisions sent a message without giving an order** (73 of 239 on seed 11). The agents talked instead of acting. Band never used `create_room`.
- Sub-agents: the orchestrator's queue is short, but bodies sit idle between spawns (idle agent-ticks 126–156, the highest of all teams). The forecast almost never reached a non-scout (0–1 tick lead).

Fix (prompt v3, shared rules text, so it applies to every team with communication tools): *"a message never replaces an order. In the same turn, send what teammates need to know AND give your own order."*

## 5. Batch 2: seeds 11–13, prompt v3

The first attempt hit the Claude subscription's usage limit at tick 1; the runner aborted it (`aborted: usage_limit`) and `report` skips it. Rerun after the limit reset:

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | 10 | 14 | **43** | −20 |
| 12 | −41 | −5 | **−4** | −5 |
| 13 | 5 | −24 | **40** | −60 |
| **mean** | **−9** | **−5** | **+26** | **−28** |

- Band scored highest on 2 seeds and tied on the third. Its message-only decisions dropped, and it sent more messages (100–111 per match vs 59–75), sharing more while still acting.
- **The reference gap did not hold in this batch**: perfect ≈ none on average and below it on seed 13. The same seeds varied a lot between batches (none on seed 13: −52 then +5), so LLM variance per match is large compared to the effects.
- Likely reasons the "perfect" team is not a real ceiling with LLM agents: its prompts carry everyone's view and orders, and agents tend to herd onto the same visible fire. It remains the right *information* ceiling; it is not a *play-quality* ceiling.
- The report now computes relative score from the team means (per-seed ratios exploded, e.g. 825% on seed 11).

## 6. Before a public demo

1. Run 10–20 seeds per configuration. With per-match swings of ±50 points, 3 seeds cannot separate the teams reliably. Use the `api` backend or spread batches across usage windows (~2,000 decisions per 3 four-team matches).
2. Try one batch with a stronger model (open question §14.7): weak play adds noise that hides communication effects.
3. Look at why `perfect` underperforms (herding, prompt size), e.g. give each agent its own view plus a compact list of teammates' orders instead of the full union.
4. Keep the showcase honest: pick replays that show the mechanism (idle sub-agent bodies, forecasts that never arrive), not just the biggest score gap.

## 7. Local chat and OpenAI backend (prompt v4)

The default comparison changed from `none,perfect,band,subagents` to `none,perfect,chat-mentions,chat-broadcast`. Real Band and sub-agents remain selectable, but the default now isolates one delivery rule without credentials or network variance:

- `chat-mentions`: only mentioned teammates receive and wake.
- `chat-broadcast`: all teammates receive and wake; mentions still identify the intended recipients for noise metrics.

Both conditions expose the same tool and prompt wording except for the delivery rule. Offline fake-LLM tests verify recipient counts and deterministic replay. API smoke tests on 2026-09-28:

| Backend/model | Setup | Result | Recorded cost |
|---|---|---|---:|
| Anthropic API / `claude-haiku-4-5-20251001` | 1 tick, `none`, seed 101 | completed and verified | $0.026 |
| Anthropic API / `claude-opus-5-5` (`low` effort) | 1 tick, `none`, seed 103 | completed and verified | $0.090 |
| OpenAI Responses / `gpt-5.6-luna` (`low` effort) | 1 tick, `none`, seed 102 | blocked: supplied API key returned HTTP 401 | $0 |

The four new default teams also completed and verified a 6-tick Haiku API match on seed 104. Scores were all +45 at this short horizon; costs were `$0.071 none`, `$0.071 perfect`, `$0.091 chat-mentions`, and `$0.084 chat-broadcast`. The recording contains 10 targeted-room messages and 8 broadcast-room messages. `mentions: ["all"]` intentionally expands to all four peers in the targeted condition, while narrower mentions deliver only to the named peers.

The OpenAI path uses `store: false`, replays all response items only inside a validation-error retry, and records input, output, cache-read, cache-write, latency, and estimated cost. Full cross-model runs must wait for a valid OpenAI credential so both providers can be tested symmetrically.

### Paired advanced-model run protocol

Each requested production repetition uses seed `42`. Every match contains `none`, `perfect`, `chat-mentions`, and `chat-broadcast`, and `MatchRunner` constructs one scenario from that seed and gives the identical initial world and event schedule to all four teams. Using seed `42` for every Claude Opus 5.5 and GPT-5.6 Sol repetition keeps the world fixed across providers as well; only model sampling and the communication condition can vary. The recording header stores the seed, complete scenario, model, prompt version, and tool definitions so this pairing is auditable.

For a later statistical study, use several seeds but keep the same seed list for every model and condition (paired blocks). A single fixed seed is ideal for this requested apples-to-apples replay set, but it does not measure performance across different maps.

### Seed 42 advanced-model repetitions

Four 60-tick repetitions per model used prompt v4, low reasoning effort, a 1,024-token output cap, and the same five conditions. `chat-mentions` and `chat-broadcast` are the local simulated Band-style rooms, not real Band infrastructure. All eight recordings completed and replay-verified.

| Model | Repetition | None | Perfect | Sub-agents | Mentions | Broadcast | Winner |
|---|---:|---:|---:|---:|---:|---:|---|
| Claude Opus 5.5 | 1 | -5 | 85 | 51 | 51 | 63 | Perfect |
| Claude Opus 5.5 | 2 | -4 | 73 | 50 | 61 | 51 | Perfect |
| Claude Opus 5.5 | 3 | -9 | 20 | 44 | 36 | 54 | Broadcast |
| Claude Opus 5.5 | 4 | 1 | 82 | 47 | 55 | 12 | Perfect |
| GPT-5.6 Sol | 1 | -11 | 48 | 53 | 52 | 50 | Sub-agents |
| GPT-5.6 Sol | 2 | 31 | 15 | 10 | 56 | 51 | Mentions |
| GPT-5.6 Sol | 3 | -12 | 49 | 43 | 48 | 15 | Perfect |
| GPT-5.6 Sol | 4 | -3 | 53 | 17 | 52 | 49 | Perfect |

Model-specific score summaries (mean ± sample standard deviation):

| Model | None | Perfect | Sub-agents | Mentions | Broadcast |
|---|---:|---:|---:|---:|---:|
| Claude Opus 5.5 | -4.3 ± 4.1 | **65.0 ± 30.4** | 48.0 ± 3.2 | 50.8 ± 10.7 | 45.0 ± 22.6 |
| GPT-5.6 Sol | 1.3 ± 20.2 | 41.3 ± 17.6 | 30.8 ± 20.5 | **52.0 ± 3.3** | 41.3 ± 17.5 |

Across the eight equally weighted recordings, perfect won 5, and sub-agents, mentions, and broadcast won 1 each; none won 0. The descriptive combined means were perfect 53.1, mentions 51.4, broadcast 43.1, sub-agents 39.4, and none -1.5. Keep the model-specific tables as the formal comparison: mixing backends can hide model/transport interactions.

The main mechanism result is clearer than the overall winner count. Mentions beat broadcast head-to-head in all four Sol repetitions and 6 of 8 recordings overall. Broadcast woke every peer, producing more LLM calls and noise: mean noise was 50% for Opus and 61% for Sol, versus 0% for targeted mentions. It was also the most expensive condition. Total recorded API cost for the eight matches was approximately $87.08 ($50.67 Opus, $36.41 Sol).

These repetitions estimate model sampling variance on one fixed world. They do not establish performance across wildfire maps; that requires paired multi-seed blocks.

## 8. Task-lived sub-agents and joint coverage (prompt v5)

The original sub-agent condition forcibly ended every worker after 8 ticks. That made bodies repeatedly lose task context even when an assignment was still in progress. Prompt v5 makes workers task-lived: one worker owns one assignment until it explicitly reports `completed` or `blocked`, and its accumulated sightings are carried into each stateless decision. The old cutoff remains available as `subagents.max_lifetime_ticks: 8`; the new default `0` disables it. Offline lifecycle tests cover both modes (no automatic report after 10 ticks by default; an automatic blocked report at tick 8 when opted in). Production scores above are prompt-v4 results and must not be compared directly with new prompt-v5 runs.

The old “missed joint” metric only counted a firefighter already adjacent to an intensity-3 fire and spraying alone. On `20260928-065207-s42-err3.sqlite` it reported `0` for all five teams, although every team experienced 20 intensity-3 fire-ticks and none ever assigned both firefighters to the same intensity-3 target (perfect assigned one firefighter for 1 tick; the other conditions assigned none). The replacement metric counts intensity-3 fire-ticks with fewer than two assigned firefighters, producing `20` rather than the misleading `0` for each condition in that recording.

Prompt v5 also makes the clock and fire severity explicit. Every agent receives total ticks, current tick, and ticks remaining in the system layer. Observations already expose exact numeric intensity; the shared prompt now states that higher intensity raises spread probability, intensity 3 is maximum severity, and threatening intensity-3 fires require an immediate paired assignment.
