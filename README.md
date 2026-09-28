# Firebreak

A live, replayable game that compares how well teams of AI agents coordinate when the only difference between them is how they communicate.

Teams of 5 AI firefighters defend identical copies of a town from spreading wildfires, side by side, on the same seed and the same clock. Every match is recorded to one SQLite file and can be replayed at any speed, verified, measured, and exported as a single HTML file.

| Team                        | How it communicates                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `chat-mentions`             | Local shared room; only explicitly mentioned teammates receive each message                        |
| `chat-broadcast`            | Local shared room; every teammate receives every message, while mentions mark the intended readers |
| `none`                      | No communication (lower bound)                                                                     |
| `perfect`                   | Everyone sees everything any teammate sees, instantly (upper bound)                                |
| `band`                      | Optional real Band rooms through `@band-ai/sdk`                                                    |
| `subagents`                 | Optional orchestrator that spawns ephemeral workers                                                |
| `bots-none`, `bots-perfect` | Scripted bots, no LLM (for development and tuning)                                                 |

- [Specification](docs/SPEC.md) · [Implementation plan](docs/PLAN.md) · [Tuning notes](docs/TUNING.md) · [Guide for coding agents](AGENTS.md)

## Setup

```bash
pnpm install
cp .env.example .env                 # API credentials, if using a billed backend
cp band_agents.yaml.example band_agents.yaml   # only needed for the band team
```

Requires Node 22.13+ and pnpm. LLM teams run on your Claude subscription by default (`llm.backend: claude-code`, using the local `claude` login). Use `llm.backend=api` with `ANTHROPIC_API_KEY` for the Claude API, or `llm.backend=openai` with `OPENAI_API_KEY` for the OpenAI Responses API. The CLI reads credentials from the process environment; it does not load `.env` itself.

## Run a match

```bash
# All four teams, 60 ticks × 5 s, with the live viewer at http://localhost:5173/?live
pnpm firebreak run --live

# Pick teams, seed, provider and any config value
pnpm firebreak run --teams chat-mentions,chat-broadcast --seed 7 --set ticks=30
pnpm firebreak run --set llm.backend=openai --set llm.model=gpt-5.6-luna

# Scripted bots, instant (no LLM)
pnpm firebreak run --teams bots-none,bots-perfect --virtual
```

## Working with recordings

Every match is one SQLite file: `runs/` for your own matches (git-ignored), `recordings/` for curated ones committed to the repo ([index](recordings/README.md)). Commands take a path or just the file name; both folders are searched.

```bash
pnpm firebreak list                                     # all recordings, with scores
pnpm firebreak replay 20260927-184427-s13-mmr7.sqlite   # watch it (add ?t=120&speed=4 to the URL)
pnpm firebreak verify 20260927-184427-s13-mmr7.sqlite   # re-run the engine, compare every tick hash
pnpm firebreak metrics 20260927-184427-s13-mmr7.sqlite  # per-team metrics as JSON
pnpm firebreak report recordings/*.sqlite               # HTML summary across several matches
pnpm firebreak export 20260927-184427-s13-mmr7.sqlite   # single offline HTML file to share
pnpm firebreak run --config-from 20260927-184427-s13-mmr7.sqlite --seed 14   # same setup, new seed
```

Viewer keys: space play/pause, ←/→ step a tick, 1–5 speed (0.5×–10×), drag the timeline to seek, click an agent to see what it saw and decided, click a board's header to focus on that team.

A recording holds everything needed to replay and analyse a match without calling a model:

| Table                  | Contents                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `match`                | id, seed, status (`completed` / `aborted`), abort reason, header (incl. the scenario)                                            |
| `match_config`         | one row per section: `resolved` config, `llm`, `prompts`, `tools`, `code` (git commit), `environment`, `source_text`, `cli_args` |
| `world`                | one row per team: final score, cost                                                                                              |
| `tick_state`           | full world state (JSON) and hash for every tick                                                                                  |
| `event`                | orders issued/rejected/blocked/done, fires, civilians, spawns, reports, rooms…                                                   |
| `message` / `delivery` | every message, and when each recipient received (`delivered`) and read (`consumed`) it                                           |
| `llm_call`             | every decision: prompt, response, tool calls, tokens, latency, cost                                                              |

Query it directly with the `sqlite3` CLI:

```bash
R=recordings/20260927-184427-s13-mmr7.sqlite
sqlite3 -header -column $R "SELECT team, final_score, round(cost_usd, 2) AS usd FROM world"
sqlite3 $R "SELECT t_ms/5000 AS tick, sender, channel, text FROM message WHERE world_id = 'w3-band' ORDER BY t_ms"
sqlite3 $R "SELECT agent_id, response, tool_calls_json FROM llm_call WHERE world_id = 'w4-subagents' AND agent_id = 'orchestrator'"
sqlite3 $R "SELECT m.world_id, round(avg(d.t_ms - m.t_ms)) AS ms FROM delivery d JOIN message m ON m.id = d.message_id WHERE d.stage = 'delivered' GROUP BY 1"
sqlite3 $R "SELECT json_extract(value_json, '$.model') FROM match_config WHERE section = 'llm'"
```

World ids are `w<N>-<team>` (e.g. `w3-band`); agent ids are `scout`, `ff1`, `ff2`, `engineer`, `rescuer` (plus `orchestrator` on the sub-agent team). The full schema is in `packages/recorder/src/schema.ts`.

## Many seeds

```bash
pnpm firebreak batch --seeds 20           # asks before spending; --yes to skip
pnpm firebreak report                     # HTML summary of the latest batch
```

## Development

```bash
pnpm test        # engine rules, determinism, recording, replay, teams with a fake model
pnpm typecheck
pnpm lint
```
