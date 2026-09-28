import {
  key,
  observe,
  renderMapText,
  type Observation,
  type Role,
  type WorldEvent,
  type WorldState,
} from "@firebreak/engine";
import {
  LlmAgent,
  MessageLog,
  RULES_TEXT,
  jsonSchema,
  orderToolsFor,
  systemPrompt,
  type TeamController,
  type TeamFactory,
  type ToolDef,
  type ToolResult,
  type WorldHandle,
} from "@firebreak/runtime";
import { z } from "zod";

export const ORCHESTRATOR = "orchestrator";

const SUBAGENT_COMMS = (
  lifetime: number,
) => `You are a SUB-AGENT spawned by your team's orchestrator (the commander) to control this body for one task.
- You cannot talk to anyone. You cannot receive messages. Nobody can interrupt you.
- Own the assignment across as many decisions and ticks as it needs. Observe progress, adapt after completed or blocked orders, and keep working independently.
- Do NOT finish merely because you issued an order or reached an arbitrary number of ticks. Call finish(outcome, report) only after you verify the assignment is complete, or after you determine it is blocked/impossible and cannot recover with your role.
- Everything you saw is attached to your report automatically. Only that final report wakes the orchestrator; after you end, it may spawn a fresh sub-agent with a new brief.${
  lifetime > 0
    ? `\n- This run opted into a hard safety limit of ${lifetime} ticks. Finish and report before then when possible.`
    : "\n- There is no fixed tick limit. You remain responsible for this assignment until you report completion or blockage."
}`;

const ORCHESTRATOR_PROMPT = (map: string, lifetime: number) => `${RULES_TEXT}

MATCH CLOCK: the match length and current tick are stated in every decision. Use the remaining ticks when assigning travel and deciding which objectives can still be completed.

${map}

YOU: the ORCHESTRATOR (commander) of the team. You have no body and you cannot see the map yourself.
You only know what your sub-agents report back.

YOUR TEAM (bodies): scout (moves 2/tick, sees 5 tiles, gets the wind forecast), ff1 and ff2 (firefighters: 3 water, refill at water; intensity-3 fires need BOTH in the same tick), engineer (clears debris, builds firebreaks), rescuer (roads only, 2/tick, evacuates civilians).

HOW YOU CONTROL THE TEAM
- spawn(body, brief) starts a sub-agent that controls that body with your brief (e.g. "go to (8,16) and put out the fire there; ff2 is coming too").
- A sub-agent works on its own, cannot receive messages and cannot talk to other sub-agents. It owns the assignment until it reports verified completion or an unrecoverable blockage.${
  lifetime > 0
    ? ` This run opts into a hard ${lifetime}-tick safety limit.`
    : " There is no fixed tick limit."
}
- At most one sub-agent per body at a time. A body without a sub-agent keeps doing its last order and then waits.
- You are woken when reports arrive, and every few ticks. Idle bodies waste time: keep every body busy (e.g. send firefighters toward likely fire areas while the scout explores). Give precise briefs with coordinates.
- Act immediately: call your tools first. Write at most one short sentence, or nothing.`;

interface Sightings {
  fires: Map<string, { pos: [number, number]; intensity: number; tick: number }>;
  civilians: Map<string, { id: string; pos: [number, number]; deadline_tick: number; tick: number }>;
  debris: Map<string, { pos: [number, number]; tick: number }>;
  destroyed: Set<string>;
  bridge?: string;
  forecast?: { tick: number; wind: string }[];
}

interface Live {
  body: string;
  role: Role;
  agent: LlmAgent;
  brief: string;
  spawned: number;
  seen: Sightings;
  finished: boolean;
}

interface Report {
  id: string;
  from: string;
  tick: number;
  text: string;
  sent_ms: number;
}

/**
 * The sub-agent team (SPEC §7.4): an orchestrator with no body spawns one sub-agent per body.
 * Sub-agents get only their brief, cannot be messaged or interrupted, and report back when done.
 */
export class SubagentTeam implements TeamController {
  private world!: WorldHandle;
  private log!: MessageLog;
  private live = new Map<string, Live>();
  private reports: Report[] = [];
  private unread = 0;
  private reasons = new Set<string>(["match started: all bodies are idle at the fire station"]);
  private busy: Promise<void> | null = null;
  private stopped = false;
  private lastDecisionTick = -Infinity;
  private callSeq = 0;
  private decisionsThisTick = 0;
  private state!: WorldState;
  private orchestratorSystem = "";
  private subSystems: Record<string, string> = {};
  private orchestratorTools: ToolDef[] = [];

  async setup(world: WorldHandle): Promise<void> {
    if (!world.llm) throw new Error("subagents team needs an LLM backend");
    this.world = world;
    this.log = new MessageLog(world);
    this.state = world.state();
    const lifetime = world.config.subagents.max_lifetime_ticks;
    this.orchestratorSystem = ORCHESTRATOR_PROMPT(renderMapText(world.scenario), lifetime);
    for (const a of this.state.agents)
      this.subSystems[a.id] = systemPrompt(world.scenario, a.id, a.role, SUBAGENT_COMMS(lifetime));
    this.orchestratorTools = [
      {
        name: "spawn",
        description:
          "Start a sub-agent controlling one body with a task brief. The body must not already have a live sub-agent.",
        schema: {
          body: z.enum(["scout", "ff1", "ff2", "engineer", "rescuer"]),
          brief: z.string().describe("the task, with coordinates"),
        },
      },
      { name: "wait", description: "Do nothing until the next report.", schema: {} },
    ];
  }

  onTick(state: WorldState, events: WorldEvent[]): void {
    this.state = state;
    this.decisionsThisTick = 0;
    if (this.stopped) return;
    const lifetime = this.world.config.subagents.max_lifetime_ticks;
    for (const l of [...this.live.values()]) {
      if (l.finished) continue;
      this.recordSightings(l, observe(this.world.scenario, state, l.body));
      l.agent.onTick(state, events);
      if (lifetime > 0 && state.tick - l.spawned >= lifetime)
        this.finish(l, "blocked", `Hard ${lifetime}-tick safety limit reached before task completion.`);
    }
    const idle = state.agents.filter((a) => !this.live.has(a.id)).map((a) => a.id);
    if (state.tick - this.lastDecisionTick >= this.world.config.agent.heartbeat_ticks && idle.length) {
      this.reasons.add(`heartbeat; bodies without a sub-agent: ${idle.join(", ")}`);
    }
    this.pump();
  }

  private recordSightings(l: Live, obs: Observation) {
    const t = obs.tick;
    for (const f of obs.visible.fires)
      l.seen.fires.set(key(f.pos), { pos: f.pos, intensity: f.intensity, tick: t });
    for (const c of obs.visible.civilians) l.seen.civilians.set(c.id, { ...c, tick: t });
    for (const d of obs.visible.debris) l.seen.debris.set(key(d), { pos: d, tick: t });
    for (const h of obs.visible.houses) if (h.state === "destroyed") l.seen.destroyed.add(key(h.pos));
    if (obs.visible.bridge) l.seen.bridge = obs.visible.bridge;
    if (obs.forecast?.length) l.seen.forecast = obs.forecast;
  }

  private sightingsText(s: Sightings): string {
    const parts: string[] = [];
    if (s.fires.size)
      parts.push(
        `fires: ${[...s.fires.values()].map((f) => `(${f.pos}) i${f.intensity}@t${f.tick}`).join(" ")}`,
      );
    if (s.civilians.size)
      parts.push(
        `civilians: ${[...s.civilians.values()].map((c) => `${c.id} (${c.pos}) deadline t${c.deadline_tick}`).join(" ")}`,
      );
    if (s.debris.size) parts.push(`debris: ${[...s.debris.values()].map((d) => `(${d.pos})`).join(" ")}`);
    if (s.destroyed.size) parts.push(`destroyed houses: ${[...s.destroyed].map((k) => `(${k})`).join(" ")}`);
    if (s.bridge) parts.push(`bridge: ${s.bridge}`);
    if (s.forecast?.length)
      parts.push(`wind forecast: ${s.forecast.map((f) => `${f.wind} at t${f.tick}`).join(", ")}`);
    return parts.join("; ") || "nothing notable";
  }

  private finish(l: Live, outcome: "completed" | "blocked", text: string) {
    if (l.finished) return;
    l.finished = true;
    l.agent.stop();
    this.live.delete(l.body);
    const full = `${outcome.toUpperCase()}: ${text.trim()} | SEEN: ${this.sightingsText(l.seen)}`;
    const { id, t_ms } = this.log.sent(l.body, { to: [ORCHESTRATOR], channel: "report", text: full });
    this.log.delivered(id, ORCHESTRATOR);
    this.reports.push({ id, from: l.body, tick: this.state.tick, text: full, sent_ms: t_ms });
    this.unread += 1;
    this.world.emit({
      kind: "event",
      tick: this.state.tick,
      t_ms,
      type: "report",
      agent_id: l.body,
      payload: { text: full },
    });
    this.reasons.add(`report from ${l.body}`);
    this.pump();
  }

  private spawn(body: string, brief: string): ToolResult {
    const a = this.state.agents.find((x) => x.id === body);
    if (!a) return { text: `unknown body ${body}`, isError: true };
    if (this.live.has(body))
      return {
        text: `${body} already has a live sub-agent (spawned t${this.live.get(body)!.spawned})`,
        isError: true,
      };
    const { id } = this.log.sent(ORCHESTRATOR, { to: [body], channel: "spawn", text: brief });
    this.log.delivered(id, body);
    const seen: Sightings = {
      fires: new Map(),
      civilians: new Map(),
      debris: new Map(),
      destroyed: new Set(),
    };
    const world = this.world;
    let consumed = false;
    const live: Live = {
      body,
      role: a.role,
      brief,
      spawned: this.state.tick,
      seen,
      finished: false,
      agent: new LlmAgent({
        id: body,
        role: a.role,
        world,
        llm: world.llm!,
        system: this.subSystems[body]!,
        tools: [
          ...orderToolsFor(a.role),
          {
            name: "finish",
            description:
              "End this sub-agent and send its only report. Use completed only after verifying the assigned objective is done; use blocked only after recovery is impossible.",
            schema: {
              outcome: z.enum(["completed", "blocked"]),
              report: z.string().describe("what was achieved or why it is impossible, plus useful findings"),
            },
          },
        ],
        observe: (s) => observe(world.scenario, s, body),
        extraPrompt: () => {
          if (!consumed) {
            consumed = true;
            this.log.consumed(id, body);
          }
          return [
            `YOUR ASSIGNMENT from the orchestrator (spawned at tick ${live.spawned}): ${brief}`,
            `ACCUMULATED SIGHTINGS during this assignment: ${this.sightingsText(live.seen)}`,
            "Keep ownership of this assignment. Report only after verified completion or unrecoverable blockage.",
          ].join("\n");
        },
        executeOther: async (name, input) => {
          if (name !== "finish") return { text: `unknown tool ${name}`, isError: true };
          const outcome = input.outcome === "blocked" ? "blocked" : "completed";
          queueMicrotask(() => this.finish(live, outcome, String(input.report ?? "")));
          return { text: "report sent; this sub-agent ends now", isError: false };
        },
      }),
    };
    this.live.set(body, live);
    this.world.emit({
      kind: "event",
      tick: this.state.tick,
      t_ms: this.world.now(),
      type: "spawn",
      agent_id: body,
      payload: { brief },
    });
    this.recordSightings(live, observe(world.scenario, this.state, body));
    live.agent.onTick(this.state, []);
    return { text: `spawned a sub-agent for ${body}`, isError: false };
  }

  private pump(): void {
    if (this.busy || this.stopped || this.reasons.size === 0 || this.world.signal.aborted) return;
    if (this.decisionsThisTick >= this.world.config.agent.max_decisions_per_tick) return;
    this.decisionsThisTick++;
    this.busy = this.decide().finally(() => {
      this.busy = null;
      if (!this.stopped) queueMicrotask(() => this.pump());
    });
  }

  private async decide(): Promise<void> {
    const w = this.world;
    const reasons = [...this.reasons];
    this.reasons.clear();
    const s = this.state;
    this.lastDecisionTick = s.tick;
    const window = w.config.agent.message_window;
    const recent = this.reports.slice(-window);
    const newCount = Math.min(this.unread, recent.length);
    for (const r of recent.slice(recent.length - newCount)) this.log.consumed(r.id, ORCHESTRATOR);
    this.unread = 0;
    const bodies = s.agents.map((a) => {
      const l = this.live.get(a.id);
      return l
        ? `- ${a.id} (${a.role}): sub-agent running since t${l.spawned}, brief: "${l.brief}"`
        : `- ${a.id} (${a.role}): NO sub-agent (idle or finishing its last order)`;
    });
    const user = [
      `TICK ${s.tick} (${w.config.ticks - s.tick} ticks left). Woken because: ${reasons.join("; ")}.`,
      `Current wind (everyone can feel it): ${s.wind}.`,
      "",
      "BODIES:",
      ...bodies,
      "",
      recent.length ? `REPORTS (oldest first; the last ${newCount} are new):` : "No reports yet.",
      ...recent.map((r) => `[t${r.tick}] ${r.from}: ${r.text}`),
      "",
      "Decide now.",
    ].join("\n");
    w.emit({
      kind: "event",
      tick: s.tick,
      t_ms: w.now(),
      type: "wake",
      agent_id: ORCHESTRATOR,
      payload: { reasons },
    });
    const started = w.now();
    const decisionSystem = `${this.orchestratorSystem}\n\nCURRENT MATCH TIME: tick ${s.tick} of ${w.config.ticks}; ${w.config.ticks - s.tick} ticks remain. Assign only work that can matter within that time.`;
    const res = await w.llm!.decide({
      system: decisionSystem,
      user,
      tools: this.orchestratorTools,
      maxTurns: w.config.llm.max_turns_per_decision,
      signal: w.signal,
      execute: async (name, input) =>
        name === "spawn"
          ? this.spawn(String(input.body), String(input.brief ?? ""))
          : name === "wait"
            ? { text: "ok", isError: false }
            : { text: `unknown tool ${name}`, isError: true },
    });
    w.budget.add(w.worldId, res.input_tokens + res.output_tokens, res.cost_usd);
    w.emit({
      kind: "llm",
      id: `${w.worldId}-${ORCHESTRATOR}-c${++this.callSeq}`,
      agent_id: ORCHESTRATOR,
      started_ms: started,
      ended_ms: w.now(),
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      cache_read_tokens: res.cache_read_tokens,
      cost_usd: res.cost_usd,
      cost_estimated: res.cost_estimated,
      ...(w.config.record.prompts ? { prompt: `SYSTEM\n${decisionSystem}\n\nUSER\n${user}` } : {}),
      response: res.response,
      tool_calls: res.tool_calls,
      ...(res.error ? { error: res.error } : {}),
    });
    if (res.fatal) w.abort(res.fatal === "usage_limit" ? "usage_limit" : "llm_auth_failed");
  }

  async idle(): Promise<void> {
    while (this.busy) await this.busy;
    await Promise.all([...this.live.values()].map((l) => l.agent.idle()));
  }

  async teardown(): Promise<void> {
    this.stopped = true;
    for (const l of this.live.values()) l.agent.stop();
  }

  describe() {
    return {
      prompts: { [ORCHESTRATOR]: this.orchestratorSystem, ...this.subSystems },
      tools: {
        [ORCHESTRATOR]: this.orchestratorTools.map((d) => ({
          name: d.name,
          description: d.description,
          input_schema: jsonSchema(d),
        })),
      },
    };
  }
}

export const subagents: TeamFactory = {
  type: "subagents",
  label: "Sub-agents",
  usesLlm: true,
  create: () => new SubagentTeam(),
};
