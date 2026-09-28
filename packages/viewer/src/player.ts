import { formatOrder, type LlmFrame } from "@firebreak/engine";
import { compactRoleLegend, createLegendDialog, rulesHref } from "./reference";
import { HQ_ID, drawBoard, type HitTarget } from "./render";
import type { OutcomeMetric, Timeline, WorldTimeline } from "./timeline";

const SPEEDS = [0.5, 1, 2, 4, 10];
const TIMELINE_MARKERS = {
  civilian_lost: { color: "#ff4d6d", label: "civilian lost" },
  civilian_evacuated: { color: "#7cfc9a", label: "civilian evacuated" },
  house_destroyed: { color: "#ff9f43", label: "house destroyed" },
  wind_changed: { color: "#5bc0eb", label: "wind changed" },
  bridge_collapsed: { color: "#c792ea", label: "bridge collapsed" },
} as const;

const CHART_METRICS: Record<OutcomeMetric, { label: string; help: string; better: "high" | "low" }> = {
  score: { label: "Score", help: "Total points at each tick", better: "high" },
  extinguished: { label: "Fires out", help: "Cumulative fire tiles extinguished", better: "high" },
  active_fires: { label: "Active fires", help: "Fire tiles currently burning", better: "low" },
  evacuated: { label: "Civilians saved", help: "Cumulative civilian evacuations", better: "high" },
  lost: { label: "Civilians lost", help: "Cumulative civilian losses", better: "low" },
  houses_standing: { label: "Houses standing", help: "Houses still standing", better: "high" },
  houses_destroyed: { label: "Houses destroyed", help: "Cumulative houses destroyed", better: "low" },
};

const TEAM_COLORS = ["#ff7a3d", "#7cfc9a", "#c792ea", "#5bc0eb", "#ffd166", "#ff6b9d"];

interface Card {
  world: WorldTimeline;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  score: HTMLElement;
  outcomes: HTMLElement;
  counters: HTMLElement;
  ticker: HTMLElement;
  commentary: HTMLElement;
  results: HTMLElement;
  hits: HitTarget[];
  visible: boolean;
}

export interface PlayerOptions {
  mode: "live" | "replay";
  /** Loads a prompt that is not embedded in the bundle. */
  fetchPrompt?(llmId: string): Promise<string | null>;
  recordingName?: string;
  /** Start position in match seconds, and whether to start paused (URL ?t=…&paused). */
  startAt?: number;
  paused?: boolean;
  speed?: number;
  /** Non-fatal automatic commentary-generation failure. */
  commentaryError?: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Plays a Timeline: replays on a virtual clock, or follows a live match (SPEC §8.3, §9). */
export class Player {
  private t = 0;
  private speed = 1;
  private playing = true;
  private followLive: boolean;
  private liveOffset: number | null = null;
  private lastVersion = -1;
  private cards: Card[] = [];
  private boardsEl!: HTMLElement;
  private scrub!: HTMLInputElement;
  private scrubMarks!: HTMLCanvasElement;
  private clockEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private inspector!: HTMLElement;
  private selected: { world: string; agent: string } | null = null;
  private inspectorKey = "";
  private lastFrame = performance.now();
  private badge!: HTMLElement;
  private legend!: HTMLDialogElement;
  private broadcastDialog!: HTMLDialogElement;
  private chartCanvas!: HTMLCanvasElement;
  private chartValues!: HTMLElement;
  private chartMetric: OutcomeMetric = "score";
  private chartWorlds = new Set<string>();
  private chartMetricButtons = new Map<OutcomeMetric, HTMLButtonElement>();
  private chartRenderKey = "";

  constructor(
    private root: HTMLElement,
    private tl: Timeline,
    private o: PlayerOptions,
  ) {
    this.followLive = o.mode === "live";
    if (o.startAt !== undefined) this.t = o.startAt * 1000;
    if (o.paused) this.playing = false;
    this.build();
    if (o.speed) this.setSpeed(o.speed);
    window.addEventListener("resize", () => this.layout());
    window.addEventListener("keydown", (e) => this.onKey(e));
    requestAnimationFrame((n) => this.frame(n));
  }

  /** Called by the live source whenever frames arrive. */
  onFrames(): void {
    if (this.o.mode === "live") this.liveOffset = performance.now() - this.tl.lastMs;
  }

  setCommentaryMessage(message?: string): void {
    this.o.commentaryError = message;
    this.lastVersion = -1;
  }

  private build() {
    const h = this.tl.header;
    const shell = el("div", "shell");
    const top = el("div", "topbar");
    const brand = el("div", "brand");
    brand.innerHTML = "FIRE<span>BREAK</span>";
    this.badge = el("span", `badge ${this.o.mode}`, this.o.mode === "live" ? "LIVE" : "REPLAY");
    const meta = el(
      "div",
      "meta",
      `seed ${h.seed} · ${h.ticks} ticks × ${h.tick_ms / 1000}s · ${h.match_id}`,
    );
    const toggles = el("div", "toggles");
    const help = el("div", "help-links");
    const legendButton = el("button", "top-action", "Legend");
    legendButton.title = "Map legend (L)";
    legendButton.addEventListener("click", () => this.legend.showModal());
    const rules = el("a", "top-action", "Rules");
    rules.href = rulesHref();
    help.append(legendButton, rules);
    top.append(brand, this.badge, meta, compactRoleLegend(), el("div", "spacer"), help, toggles);

    const main = el("div", "main");
    this.boardsEl = el("div", "boards");
    this.inspector = el("div", "inspector");
    main.append(this.boardsEl, this.inspector);

    for (const w of this.tl.worlds.values()) {
      const card = el("div", "card");
      const head = el("div", "card-head");
      const score = el("div", "score", "0");
      head.append(el("div", "label", w.label), el("div", "team", w.team), score);
      const wrap = el("div", "board-wrap");
      const canvas = el("canvas");
      const results = el("div", "results");
      results.style.display = "none";
      wrap.append(canvas, results);
      const counters = el("div", "counters");
      const outcomes = el("div", "outcomes");
      const ticker = el("div", "ticker");
      const commentary = el("section", "commentary");
      const commentaryHead = el("div", "commentary-head");
      commentaryHead.append(el("span", "", "AI BROADCAST"));
      const commentaryActions = el("span", "commentary-actions");
      commentaryActions.append(el("span", "commentary-status", "post-match observer"));
      const readCommentary = el("button", "commentary-read", "Read full");
      readCommentary.type = "button";
      readCommentary.addEventListener("click", () => this.openBroadcast(c));
      commentaryActions.append(readCommentary);
      commentaryHead.append(commentaryActions);
      commentary.append(commentaryHead, el("div", "commentary-body meta", "Waiting for commentary…"));
      card.append(head, wrap, outcomes, counters, ticker, commentary);
      this.boardsEl.append(card);
      const c: Card = {
        world: w,
        root: card,
        canvas,
        score,
        outcomes,
        counters,
        ticker,
        commentary,
        results,
        hits: [],
        visible: true,
      };
      canvas.addEventListener("click", (e) => this.onClick(c, e));
      head.title = "Click to focus on this team (click again for all)";
      head.style.cursor = "pointer";
      head.addEventListener("click", () => this.toggleFocus(c));
      this.cards.push(c);
      const lbl = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        c.visible = cb.checked;
        card.style.display = cb.checked ? "" : "none";
        this.layout();
      });
      lbl.append(cb, document.createTextNode(w.label));
      toggles.append(lbl);
    }

    this.buildOutcomeChart();

    const controls = el("div", "controls");
    this.playBtn = el("button", "", "❚❚");
    this.playBtn.title = "Play / pause (space)";
    this.playBtn.addEventListener("click", () => this.togglePlay());
    const back = el("button", "", "◀ tick");
    back.addEventListener("click", () => this.stepTick(-1));
    const fwd = el("button", "", "tick ▶");
    fwd.addEventListener("click", () => this.stepTick(1));
    controls.append(this.playBtn, back, fwd);
    for (const s of SPEEDS) {
      const b = el("button", "", `${s}×`);
      b.addEventListener("click", () => this.setSpeed(s));
      this.speedBtns.push(b);
      controls.append(b);
    }
    const scrubWrap = el("div", "scrub");
    this.scrubMarks = el("canvas");
    this.scrub = el("input");
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.step = "1";
    this.scrub.addEventListener("input", () => {
      this.t = Number(this.scrub.value);
      this.followLive = false;
    });
    scrubWrap.append(this.scrubMarks, this.scrub);
    this.clockEl = el("div", "clock");
    const timelineKey = el("div", "timeline-key");
    timelineKey.title =
      "Timeline event markers. Team-specific outcomes may appear once per team; shared wind and bridge events appear once.";
    for (const { color, label } of Object.values(TIMELINE_MARKERS)) {
      const item = el("span");
      const mark = el("i");
      mark.style.background = color;
      item.append(mark, document.createTextNode(label));
      timelineKey.append(item);
    }
    controls.append(scrubWrap, this.clockEl, timelineKey);
    if (this.o.mode === "live") {
      const liveBtn = el("button", "", "● live");
      liveBtn.addEventListener("click", () => {
        this.followLive = true;
        this.playing = true;
      });
      controls.append(liveBtn);
    }

    this.legend = createLegendDialog();
    this.broadcastDialog = el("dialog", "broadcast-dialog") as HTMLDialogElement;
    this.broadcastDialog.addEventListener("click", (event) => {
      if (event.target === this.broadcastDialog) this.broadcastDialog.close();
    });
    shell.append(top, main, controls, this.legend, this.broadcastDialog);
    this.root.replaceChildren(shell);
    this.setSpeed(1);
    requestAnimationFrame(() => this.layout());
  }

  private buildOutcomeChart() {
    const section = el("section", "outcome-chart");
    const heading = el("div", "outcome-chart-heading");
    const title = el("div");
    title.append(
      el("h2", "", "Outcome over time"),
      el("p", "meta", "Compare communication styles at every tick."),
    );
    const metricControls = el("div", "chart-metrics");
    for (const [key, config] of Object.entries(CHART_METRICS) as [
      OutcomeMetric,
      (typeof CHART_METRICS)[OutcomeMetric],
    ][]) {
      const button = el("button", key === this.chartMetric ? "on" : "", config.label);
      button.type = "button";
      button.title = config.help;
      button.addEventListener("click", () => {
        this.chartMetric = key;
        for (const [metric, candidate] of this.chartMetricButtons)
          candidate.classList.toggle("on", metric === key);
        this.drawOutcomeChart();
      });
      this.chartMetricButtons.set(key, button);
      metricControls.append(button);
    }
    heading.append(title, metricControls);

    const teamControls = el("div", "chart-teams");
    this.cards.forEach((card, index) => {
      this.chartWorlds.add(card.world.id);
      const label = el("label");
      const checkbox = el("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.chartWorlds.add(card.world.id);
        else this.chartWorlds.delete(card.world.id);
        this.drawOutcomeChart();
      });
      const swatch = el("i");
      swatch.style.background = TEAM_COLORS[index % TEAM_COLORS.length]!;
      label.append(checkbox, swatch, document.createTextNode(card.world.label));
      teamControls.append(label);
    });

    const plot = el("div", "chart-plot");
    this.chartCanvas = el("canvas");
    this.chartCanvas.setAttribute("aria-label", "Team outcomes by tick");
    plot.append(this.chartCanvas);
    this.chartValues = el("div", "chart-values");
    section.append(heading, teamControls, plot, this.chartValues);
    this.boardsEl.append(section);
  }

  private layout() {
    const visible = this.focused ? [this.focused] : this.cards.filter((c) => c.visible);
    const n = Math.max(1, visible.length);
    const box = this.boardsEl.getBoundingClientRect();
    const W = box.width - 24;
    const H = box.height - 24;
    const chrome = 425; // card header + outcomes + counters + message ticker + broadcast booth
    let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.floor(Math.min((W - (cols - 1) * 12) / cols, (H - (rows - 1) * 12) / rows - chrome));
      // Prefer the squarer grid unless a wider one gives clearly bigger boards (it fills the screen better).
      if (size > best.size * 1.05 || (best.size === 0 && size > 0)) best = { cols, size };
    }
    const size = Math.max(220, best.size);
    this.boardsEl.style.gridTemplateColumns = `repeat(${best.cols}, ${size}px)`;
    const dpr = window.devicePixelRatio || 1;
    for (const c of this.cards) {
      c.canvas.style.width = `${size}px`;
      c.canvas.style.height = `${size}px`;
      c.canvas.width = Math.round(size * dpr);
      c.canvas.height = Math.round(size * dpr);
    }
    const r = this.scrubMarks.getBoundingClientRect();
    this.scrubMarks.width = Math.round(r.width * dpr);
    this.scrubMarks.height = Math.round(r.height * dpr);
    this.drawOutcomeChart();
    this.lastVersion = -1;
  }

  private focused: Card | null = null;

  /** Presenter mode: show one board at full size (PLAN M9). */
  private toggleFocus(c: Card) {
    this.focused = this.focused === c ? null : c;
    for (const x of this.cards) {
      const show = this.focused ? x === this.focused : x.visible;
      x.root.style.display = show ? "" : "none";
    }
    this.layout();
  }

  private togglePlay() {
    this.playing = !this.playing;
    if (this.playing && this.o.mode === "replay" && this.t >= this.tl.durationMs) this.t = 0;
  }

  private setSpeed(s: number) {
    this.speed = s;
    this.speedBtns.forEach((b, i) => b.classList.toggle("on", SPEEDS[i] === s));
  }

  private stepTick(d: number) {
    this.playing = false;
    this.followLive = false;
    const w = this.cards[0]!.world;
    const f = this.tl.frameAt(w, this.t);
    const tick = Math.max(0, Math.min(this.tl.maxTick(w), (f?.tick ?? 0) + d));
    this.t = this.tl.tickTime(w, tick);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range")
      return;
    if (e.key === " ") {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === "ArrowRight") this.stepTick(1);
    else if (e.key === "ArrowLeft") this.stepTick(-1);
    else if (e.key >= "1" && e.key <= "5") this.setSpeed(SPEEDS[Number(e.key) - 1]!);
    else if (e.key.toLowerCase() === "l" && !this.legend.open) this.legend.showModal();
    else if (e.key === "Escape") this.closeInspector();
  }

  private onClick(c: Card, e: MouseEvent) {
    const r = c.canvas.getBoundingClientRect();
    const dpr = c.canvas.width / r.width;
    const x = (e.clientX - r.left) * dpr;
    const y = (e.clientY - r.top) * dpr;
    const hit = c.hits.find((h) => (h.x - x) ** 2 + (h.y - y) ** 2 <= h.r * h.r);
    if (hit) {
      this.selected = { world: c.world.id, agent: hit.id };
      this.inspector.classList.add("open");
      this.inspectorKey = "";
      this.layout();
    }
  }

  private closeInspector() {
    this.selected = null;
    this.inspector.classList.remove("open");
    this.layout();
  }

  private frame(now: number) {
    const dt = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    const dur = this.tl.durationMs;
    if (this.o.mode === "live" && this.followLive && this.liveOffset !== null) {
      this.t = Math.min(now - this.liveOffset, this.tl.lastMs + this.tl.tickMs);
    } else if (this.playing) {
      this.t = Math.min(dur, this.t + dt * this.speed);
      if (this.o.mode === "replay" && this.t >= dur) this.playing = false;
    }
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
    if (this.tl.end && this.o.mode === "live") {
      this.badge.textContent = "FINISHED";
      this.badge.className = "badge replay";
    }
    this.scrub.max = String(Math.max(1, Math.ceil(dur)));
    if (document.activeElement !== this.scrub) this.scrub.value = String(Math.round(this.t));
    this.render();
    requestAnimationFrame((n) => this.frame(n));
  }

  private render() {
    const t = this.t;
    const holdMs = 900 * Math.max(1, this.speed);
    let leader: Card | null = null;
    let leaderScore = -Infinity;
    let tickShown = 0;
    for (const c of this.cards) {
      if (!c.visible || (this.focused && c !== this.focused)) continue;
      const f = this.tl.frameAt(c.world, t);
      const ctx = c.canvas.getContext("2d")!;
      ctx.fillStyle = "#11131c";
      ctx.fillRect(0, 0, c.canvas.width, c.canvas.height);
      if (!f) continue;
      tickShown = Math.max(tickShown, f.tick);
      const size = c.canvas.width;
      const cell = size / f.cur.size;
      c.hits = drawBoard(
        ctx,
        { x: 0, y: 0, cell, size },
        {
          scenario: this.tl.header.scenario,
          cur: f.cur,
          next: f.next,
          alpha: f.alpha,
          t,
          messages: this.tl.activeMessages(c.world, t, holdMs),
          holdMs,
          selected: this.selected?.world === c.world.id ? this.selected.agent : null,
          showHq: c.world.team === "subagents",
        },
      );
      const score = f.cur.score.total;
      c.score.textContent = String(score);
      if (score > leaderScore) {
        leaderScore = score;
        leader = c;
      }
      const k = this.tl.counters(c.world, t, f.tick);
      const counter = (v: string | number, label: string, title = "") =>
        `<div class="counter"${title ? ` title="${title}"` : ""}><b>${v}</b><span>${label}</span></div>`;
      const outcome = f.cur.score;
      const missionStat = (v: number, label: string, tone: "good" | "bad" | "neutral", title: string) =>
        `<div class="outcome ${tone}" title="${title}"><b>${v}</b><span>${label}</span></div>`;
      c.outcomes.innerHTML =
        missionStat(
          outcome.evacuated,
          `saved +${outcome.evacuated * 10}`,
          "good",
          "Civilians evacuated: 10 points each.",
        ) +
        missionStat(
          outcome.lost,
          `lost −${outcome.lost * 20}`,
          "bad",
          "Civilians lost: minus 20 points each.",
        ) +
        missionStat(
          outcome.extinguished,
          `fires out +${outcome.extinguished}`,
          "good",
          "Fire tiles extinguished: 1 point each.",
        ) +
        missionStat(
          f.cur.fires.length,
          "fires active",
          f.cur.fires.length ? "bad" : "good",
          "Fire tiles currently burning. This is not directly scored.",
        ) +
        missionStat(
          outcome.houses_standing,
          `standing +${outcome.houses_standing * 5}`,
          "good",
          "Houses still standing: 5 points each at match end.",
        ) +
        missionStat(
          outcome.houses_destroyed,
          "destroyed",
          outcome.houses_destroyed ? "bad" : "neutral",
          "Houses destroyed. Each one removes the opportunity to earn 5 end-of-match points.",
        );
      c.counters.innerHTML =
        counter(`$${k.cost.toFixed(2)}`, "cost") +
        counter(k.calls, "LLM calls") +
        counter(k.messages, "messages") +
        counter(k.stale, "stale actions") +
        counter(k.idle, "idle agent-ticks") +
        counter(
          k.joint,
          "missed joint",
          "Ticks where only one firefighter tried an intensity-3 fire; two are required in the same tick.",
        );
      const recent = this.tl.recentMessages(c.world, t, 3);
      c.ticker.innerHTML = recent.length
        ? recent
            .map(
              (m) =>
                `<div><b>${esc(m.from)}</b> → ${esc(m.to.join(", ") || m.channel)}: ${esc(m.text)}</div>`,
            )
            .join("")
        : `<div>${c.world.team.startsWith("none") || c.world.team === "perfect" ? "no messages on this team" : "no messages yet"}</div>`;
      const commentary = this.tl.commentaryAt(c.world, t);
      const body = c.commentary.querySelector(".commentary-body")!;
      const status = c.commentary.querySelector(".commentary-status")!;
      if (commentary) {
        status.textContent = "omniscient replay commentary";
        body.className = "commentary-body";
        body.innerHTML = commentary.commentary
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((paragraph) => `<p>${esc(paragraph.trim())}</p>`)
          .join("");
      } else {
        status.textContent = "post-match observer";
        body.className = "commentary-body meta";
        body.textContent =
          this.o.commentaryError ??
          (this.o.mode === "live"
            ? "The broadcast is generated after the outcome is fixed, then saved with the replay."
            : "No broadcast checkpoint yet.");
      }
      const ended =
        f.cur.ended && f.tick === this.tl.maxTick(c.world) && t >= this.tl.tickTime(c.world, f.tick);
      c.results.style.display = ended ? "flex" : "none";
      if (ended) c.results.innerHTML = `<div>${score} pts</div>`;
    }
    for (const c of this.cards) c.root.classList.toggle("leader", c === leader && this.cards.length > 1);
    const secs = (t / 1000).toFixed(1);
    this.clockEl.textContent = `tick ${tickShown} / ${this.tl.header.ticks} · ${secs}s · ${this.speed}×`;
    this.drawMarks();
    this.drawOutcomeChart();
    this.renderInspector(t);
  }

  private drawOutcomeChart() {
    if (!this.chartCanvas || !this.chartValues) return;
    const rect = this.chartCanvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(rect.width * dpr);
    const pixelHeight = Math.round(rect.height * dpr);
    if (this.chartCanvas.width !== pixelWidth || this.chartCanvas.height !== pixelHeight) {
      this.chartCanvas.width = pixelWidth;
      this.chartCanvas.height = pixelHeight;
    }
    const ctx = this.chartCanvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;

    const selected = this.cards
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => this.chartWorlds.has(card.world.id));
    const reference = selected[0]?.card.world;
    const currentTick = reference ? (this.tl.frameAt(reference, this.t)?.tick ?? 0) : 0;
    const renderKey = [
      this.tl.version,
      this.chartMetric,
      [...this.chartWorlds].join(","),
      currentTick,
      pixelWidth,
      pixelHeight,
    ].join("|");
    if (renderKey === this.chartRenderKey) return;
    this.chartRenderKey = renderKey;
    ctx.clearRect(0, 0, width, height);
    const series = selected.map(({ card, index }) => ({
      card,
      color: TEAM_COLORS[index % TEAM_COLORS.length]!,
      points: this.tl.outcomeSeries(card.world, this.chartMetric),
    }));
    const allValues = series.flatMap((item) => item.points.map((point) => point.value));
    if (!allValues.length) {
      ctx.fillStyle = "#9097b1";
      ctx.font = "13px system-ui";
      ctx.fillText("Select at least one communication style.", 18, 30);
      this.chartValues.replaceChildren();
      return;
    }

    const margin = { left: 52, right: 18, top: 16, bottom: 30 };
    const plotWidth = Math.max(1, width - margin.left - margin.right);
    const plotHeight = Math.max(1, height - margin.top - margin.bottom);
    const maxTick = Math.max(
      this.tl.header.ticks,
      ...series.flatMap((item) => item.points.map((p) => p.tick)),
    );
    let minValue = Math.min(0, ...allValues);
    let maxValue = Math.max(0, ...allValues);
    if (minValue === maxValue) maxValue = minValue + 1;
    const padding = Math.max(1, (maxValue - minValue) * 0.06);
    if (minValue < 0) minValue -= padding;
    maxValue += padding;
    const x = (tick: number) => margin.left + (tick / Math.max(1, maxTick)) * plotWidth;
    const y = (value: number) => margin.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;

    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const value = minValue + ((maxValue - minValue) * i) / 4;
      const py = y(value);
      ctx.strokeStyle = value === 0 ? "#596078" : "#2e3348";
      ctx.lineWidth = value === 0 ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(margin.left, py);
      ctx.lineTo(width - margin.right, py);
      ctx.stroke();
      ctx.fillStyle = "#9097b1";
      const label = Math.abs(maxValue - minValue) < 8 ? Number(value.toFixed(1)) : Math.round(value);
      ctx.fillText(String(label), margin.left - 8, py);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const tick = Math.round((maxTick * i) / 4);
      ctx.fillStyle = "#9097b1";
      ctx.fillText(String(tick), x(tick), height - margin.bottom + 8);
    }
    ctx.textAlign = "right";
    ctx.fillText("tick", width - margin.right, height - 13);

    for (const item of series) {
      if (!item.points.length) continue;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      item.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(x(point.tick), y(point.value));
        else ctx.lineTo(x(point.tick), y(point.value));
      });
      ctx.stroke();
    }

    const playheadX = x(currentTick);
    ctx.strokeStyle = "rgba(232, 233, 240, 0.72)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(playheadX, margin.top);
    ctx.lineTo(playheadX, height - margin.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const metric = CHART_METRICS[this.chartMetric];
    this.chartValues.replaceChildren();
    this.chartValues.append(
      el(
        "span",
        `chart-direction ${metric.better}`,
        metric.better === "high" ? "Higher is better" : "Lower is better",
      ),
    );
    for (const item of series) {
      const snapshot = this.tl.outcomesAt(item.card.world, this.t);
      if (!snapshot) continue;
      const chip = el("span", "chart-value");
      const swatch = el("i");
      swatch.style.background = item.color;
      const value = snapshot[this.chartMetric];
      chip.append(swatch, document.createTextNode(`${item.card.world.label}: ${value}`));
      this.chartValues.append(chip);
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(playheadX, y(value), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#11131c";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private drawMarks() {
    if (this.lastVersion === this.tl.version) return;
    this.lastVersion = this.tl.version;
    const cv = this.scrubMarks;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const dur = Math.max(1, this.tl.durationMs);
    for (const m of this.tl.markers()) {
      ctx.fillStyle = TIMELINE_MARKERS[m.type as keyof typeof TIMELINE_MARKERS]?.color ?? "#999";
      const x = (m.t / dur) * cv.width;
      ctx.fillRect(x - 1, 0, 2, cv.height * 0.35);
    }
  }

  private renderInspector(t: number) {
    if (!this.selected) return;
    const w = this.tl.worlds.get(this.selected.world)!;
    const f = this.tl.frameAt(w, t);
    const agentId = this.selected.agent;
    const call = this.tl.lastLlmCall(w, agentId, t);
    const key = `${agentId}|${f?.tick}|${call?.id}`;
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    const a = f?.cur.agents.find((x) => x.id === agentId);
    const box = this.inspector;
    box.replaceChildren();
    const close = el("button", "close", "×");
    close.addEventListener("click", () => this.closeInspector());
    box.append(close, el("h3", "", `${agentId} · ${w.label}`));
    if (a) {
      const kv = el("div", "kv");
      const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
      row("role", a.role);
      row("position", `(${a.pos.join(",")})`);
      row(
        "order",
        `${formatOrder(a.order) ?? "none"} · ${a.order_status}${a.block_reason ? ` (${a.block_reason})` : ""}`,
      );
      if (a.role === "firefighter") row("water", String(a.water));
      box.append(kv);
    } else if (agentId === HQ_ID) {
      box.append(
        el("div", "meta", "The orchestrator has no body. It only knows what sub-agents report back."),
      );
    }
    const involving = w.messages
      .filter((m) => m.t_ms <= t && (m.from === agentId || m.to.includes(agentId)))
      .slice(-8);
    box.append(el("h4", "", "Recent messages"));
    if (!involving.length) box.append(el("div", "meta", "none"));
    for (const m of involving) {
      const d = el("div", "msg");
      d.innerHTML = `<span class="who">${esc(m.from)} → ${esc(m.to.join(", ") || m.channel)}</span> <span class="meta">t${Math.floor(m.t_ms / this.tl.tickMs)}</span><br>${esc(m.text)}`;
      box.append(d);
    }
    box.append(el("h4", "", "Last decision"));
    if (!call) {
      box.append(el("div", "meta", w.team.startsWith("bots") ? "Scripted bot: no LLM." : "No decision yet."));
      return;
    }
    const kv = el("div", "kv");
    const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
    row(
      "at",
      `${(call.started_ms / 1000).toFixed(1)}s, took ${((call.ended_ms - call.started_ms) / 1000).toFixed(1)}s`,
    );
    row("tokens", `${call.input_tokens} in · ${call.output_tokens} out`);
    row("cost", `$${call.cost_usd.toFixed(4)}${call.cost_estimated ? " (est.)" : ""}`);
    if (call.error) row("error", call.error);
    box.append(kv);
    box.append(el("h4", "", "Tool calls"));
    box.append(
      el(
        "pre",
        "",
        call.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.input)})\n  → ${c.result}`).join("\n") ||
          "(none)",
      ),
    );
    if (call.response) {
      box.append(el("h4", "", "Model text"));
      box.append(el("pre", "", call.response));
    }
    box.append(el("h4", "", "Prompt"));
    const pre = el("pre", "", call.prompt ?? "loading…");
    box.append(pre);
    if (!call.prompt) void this.loadPrompt(call, pre);
  }

  private openBroadcast(c: Card) {
    const updates = this.tl.commentaryThrough(c.world, this.t);
    const dialog = this.broadcastDialog;
    dialog.replaceChildren();
    const close = el("button", "dialog-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close broadcast transcript");
    close.addEventListener("click", () => dialog.close());
    dialog.append(close, el("div", "eyebrow", "AI broadcast"), el("h2", "", c.world.label));
    if (!updates.length) {
      dialog.append(el("p", "meta", this.o.commentaryError ?? "No broadcast update is available yet."));
    } else {
      const transcript = el("div", "broadcast-transcript");
      updates.forEach((update, index) => {
        const article = el("article", index === 0 ? "latest" : "");
        article.append(el("h3", "", index === 0 ? "Latest update" : "Earlier update"));
        for (const paragraph of update.commentary.split(/\n\s*\n/).filter(Boolean))
          article.append(el("p", "", paragraph.trim()));
        transcript.append(article);
      });
      dialog.append(transcript);
    }
    dialog.showModal();
  }

  private async loadPrompt(call: LlmFrame, pre: HTMLElement) {
    const p = this.o.fetchPrompt ? await this.o.fetchPrompt(call.id) : null;
    pre.textContent = p ?? "(prompt not included in this recording)";
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
