import type {
  CommentaryFrame,
  CommentarySegment,
  DeliveryFrame,
  EndFrame,
  EventFrame,
  LlmFrame,
  MatchHeader,
  MessageFrame,
  StreamFrame,
  TickFrame,
  WorldState,
} from "@firebreak/engine";

export interface MessageView extends MessageFrame {
  delivered: Map<string, number>;
  consumed: Map<string, number>;
}

export interface WorldTimeline {
  id: string;
  team: string;
  label: string;
  ticks: TickFrame[];
  events: EventFrame[];
  messages: MessageView[];
  llm: LlmFrame[];
  commentary: CommentaryFrame[];
}

export type OutcomeMetric =
  "score" | "extinguished" | "active_fires" | "evacuated" | "lost" | "houses_standing" | "houses_destroyed";

export interface OutcomeSnapshot {
  tick: number;
  t_ms: number;
  score: number;
  extinguished: number;
  active_fires: number;
  evacuated: number;
  lost: number;
  houses_standing: number;
  houses_destroyed: number;
}

const STALE_REASONS = new Set([
  "no_fire_at_target",
  "civilian_gone",
  "no_debris_at_target",
  "not_buildable",
  "no_path",
]);

/**
 * All frames of a match, indexed for time queries. Live matches append frames as they arrive;
 * replays load them all at once. Same object either way (SPEC §8.4).
 */
export class Timeline {
  worlds = new Map<string, WorldTimeline>();
  end: EndFrame | null = null;
  lastMs = 0;
  private finalTickMs = 0;
  private messageIndex = new Map<string, MessageView>();
  version = 0;

  constructor(readonly header: MatchHeader) {
    for (const t of header.teams) {
      this.worlds.set(t.world_id, {
        id: t.world_id,
        team: t.team,
        label: t.label,
        ticks: [],
        events: [],
        messages: [],
        llm: [],
        commentary: [],
      });
    }
  }

  get tickMs(): number {
    return Math.max(1, this.header.tick_ms);
  }

  add(f: StreamFrame): void {
    this.version++;
    if (f.kind === "end") {
      this.end = f;
      this.lastMs = Math.max(this.lastMs, f.t_ms);
      return;
    }
    const w = this.worlds.get(f.world_id);
    if (!w) return;
    switch (f.kind) {
      case "tick":
        w.ticks[f.tick] = f;
        this.lastMs = Math.max(this.lastMs, f.t_ms);
        this.finalTickMs = Math.max(this.finalTickMs, f.t_ms);
        break;
      case "event":
        w.events.push(f);
        break;
      case "message": {
        const m: MessageView = { ...f, delivered: new Map(), consumed: new Map() };
        w.messages.push(m);
        this.messageIndex.set(f.id, m);
        break;
      }
      case "delivery": {
        const m = this.messageIndex.get((f as DeliveryFrame).message_id);
        if (m) (f.stage === "delivered" ? m.delivered : m.consumed).set(f.recipient, f.t_ms);
        break;
      }
      case "llm":
        w.llm.push(f);
        break;
      case "commentary":
        w.commentary.push(f);
        break;
    }
  }

  /** Match time of the last frame (or the end frame). */
  get durationMs(): number {
    // A completed match can spend time draining already in-flight LLM calls after
    // the final playable tick. Those calls cannot change the world, so they must
    // not create a motionless tail at the end of the replay scrubber.
    return this.end?.status === "completed"
      ? this.finalTickMs
      : this.end
        ? Math.max(this.end.t_ms, this.lastMs)
        : this.lastMs;
  }

  maxTick(w: WorldTimeline): number {
    return w.ticks.length - 1;
  }

  /** The tick shown at time t, plus the next one for interpolation. */
  frameAt(
    w: WorldTimeline,
    t: number,
  ): { cur: WorldState; next: WorldState | null; alpha: number; tick: number } | null {
    if (w.ticks.length === 0) return null;
    let lo = 0;
    let hi = w.ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const m = w.ticks[mid];
      if (m && m.t_ms <= t) lo = mid;
      else hi = mid - 1;
    }
    const cur = w.ticks[lo]!;
    const nxt = w.ticks[lo + 1];
    const alpha = nxt ? Math.min(1, Math.max(0, (t - cur.t_ms) / Math.max(1, nxt.t_ms - cur.t_ms))) : 0;
    return { cur: cur.state, next: nxt?.state ?? null, alpha, tick: lo };
  }

  tickTime(w: WorldTimeline, tick: number): number {
    const f = w.ticks[Math.max(0, Math.min(tick, w.ticks.length - 1))];
    return f ? f.t_ms : tick * this.tickMs;
  }

  /** Live counters under each board (SPEC §9), computed from frames up to time t. */
  counters(w: WorldTimeline, t: number, tick: number) {
    let cost = 0;
    let calls = 0;
    for (const c of w.llm)
      if (c.ended_ms <= t) {
        cost += c.cost_usd;
        calls++;
      }
    let stale = 0;
    for (const e of w.events) {
      if (e.t_ms > t) continue;
      if (e.type === "order_blocked" && STALE_REASONS.has(String(e.payload.reason))) stale++;
    }
    let messages = 0;
    for (const m of w.messages) if (m.t_ms <= t) messages++;
    let idle = 0;
    let joint = 0;
    for (let i = 1; i <= tick && i < w.ticks.length; i++) {
      const state = w.ticks[i]!.state;
      for (const a of state.agents) if (a.order_status !== "active") idle++;
      for (const fire of state.fires) {
        if (fire.intensity !== 3) continue;
        const assigned = state.agents.filter(
          (agent) =>
            agent.role === "firefighter" &&
            agent.order_status === "active" &&
            agent.order?.type === "extinguish" &&
            agent.order.x === fire.pos[0] &&
            agent.order.y === fire.pos[1],
        ).length;
        if (assigned < 2) joint++;
      }
    }
    return { cost, calls, stale, joint, messages, idle };
  }

  /** Mission outcomes at a replay position. These come from recorded world state, not inferred events. */
  outcomesAt(w: WorldTimeline, t: number): OutcomeSnapshot | null {
    const frame = this.frameAt(w, t);
    if (!frame) return null;
    const { score, fires } = frame.cur;
    return {
      tick: frame.tick,
      t_ms: this.tickTime(w, frame.tick),
      score: score.total,
      extinguished: score.extinguished,
      active_fires: fires.length,
      evacuated: score.evacuated,
      lost: score.lost,
      houses_standing: score.houses_standing,
      houses_destroyed: score.houses_destroyed,
    };
  }

  /** One point per recorded tick for the comparison chart. */
  outcomeSeries(w: WorldTimeline, metric: OutcomeMetric): { tick: number; t_ms: number; value: number }[] {
    return w.ticks.flatMap((frame) =>
      frame
        ? [
            {
              tick: frame.tick,
              t_ms: frame.t_ms,
              value:
                metric === "active_fires"
                  ? frame.state.fires.length
                  : metric === "score"
                    ? frame.state.score.total
                    : frame.state.score[metric],
            },
          ]
        : [],
    );
  }

  /** Messages to draw at time t: sent within the window, not older than `holdMs` after delivery. */
  activeMessages(w: WorldTimeline, t: number, holdMs: number): MessageView[] {
    const out: MessageView[] = [];
    for (let i = w.messages.length - 1; i >= 0; i--) {
      const m = w.messages[i]!;
      if (m.t_ms > t) continue;
      if (t - m.t_ms > holdMs * 6) break;
      const lastDelivery = Math.max(m.t_ms, ...m.delivered.values());
      if (t <= lastDelivery + holdMs) out.push(m);
    }
    return out;
  }

  recentMessages(w: WorldTimeline, t: number, n: number): MessageView[] {
    const out: MessageView[] = [];
    for (let i = w.messages.length - 1; i >= 0 && out.length < n; i--)
      if (w.messages[i]!.t_ms <= t) out.push(w.messages[i]!);
    return out.reverse();
  }

  lastLlmCall(w: WorldTimeline, agent: string, t: number): LlmFrame | null {
    for (let i = w.llm.length - 1; i >= 0; i--) {
      const c = w.llm[i]!;
      if (c.agent_id === agent && c.ended_ms <= t) return c;
    }
    return null;
  }

  inFlightLlmCall(w: WorldTimeline, agent: string, t: number): LlmFrame | null {
    return w.llm.find((call) => call.agent_id === agent && call.started_ms <= t && call.ended_ms > t) ?? null;
  }

  commentaryAt(w: WorldTimeline, t: number): CommentarySegment | null {
    let best: CommentarySegment | null = null;
    for (const call of w.commentary) {
      for (const segment of call.segments) {
        if (segment.t_ms <= t && (!best || segment.t_ms >= best.t_ms)) {
          best = segment;
        }
      }
    }
    return best;
  }

  commentaryThrough(w: WorldTimeline, t: number): CommentarySegment[] {
    return w.commentary
      .flatMap((call) => call.segments)
      .filter((segment) => segment.t_ms <= t)
      .sort((a, b) => b.t_ms - a.t_ms);
  }

  /** Markers retain their world so the shared scrubber can give each team its own row. */
  markers(): { t: number; type: string; world_id: string; global: boolean }[] {
    const notable = new Set([
      "civilian_lost",
      "civilian_evacuated",
      "house_destroyed",
      "wind_changed",
      "bridge_collapsed",
    ]);
    const out: { t: number; type: string; world_id: string; global: boolean }[] = [];
    const seenGlobal = new Set<string>();
    for (const w of this.worlds.values()) {
      for (const e of w.events) {
        if (!notable.has(e.type)) continue;
        const global = e.type === "wind_changed" || e.type === "bridge_collapsed";
        const k = `${e.type}@${e.tick}`;
        if (global && seenGlobal.has(k)) continue;
        seenGlobal.add(k);
        out.push({ t: e.t_ms, type: e.type, world_id: w.id, global });
      }
    }
    return out;
  }
}
