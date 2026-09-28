import { createScenario, type MatchHeader, type WorldState } from "@firebreak/engine";
import { describe, expect, it } from "vitest";
import { Timeline } from "../src/timeline";

function fixture() {
  const scenario = createScenario(42);
  const header: MatchHeader = {
    match_id: "chart-test",
    created_at: "2026-09-28T00:00:00.000Z",
    seed: 42,
    tick_ms: 5_000,
    ticks: 60,
    teams: [{ world_id: "w0-none", team: "none", label: "No communication" }],
    scenario,
    config: {},
  };
  const timeline = new Timeline(header);
  const addTick = (tick: number, state: WorldState) =>
    timeline.add({ kind: "tick", world_id: "w0-none", tick, t_ms: tick * 5_000, state, hash: String(tick) });
  return { scenario, timeline, addTick };
}

describe("viewer outcome timeline", () => {
  it("reads mission outcomes at the selected replay tick", () => {
    const { scenario, timeline, addTick } = fixture();
    const initial = structuredClone(scenario.initial);
    const later = structuredClone(initial);
    later.tick = 1;
    later.score = {
      evacuated: 1,
      lost: 1,
      extinguished: 2,
      houses_standing: 10,
      houses_destroyed: 1,
      total: 42,
    };
    later.fires = later.fires.slice(0, 1);
    addTick(0, initial);
    addTick(1, later);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.outcomesAt(world, 4_999)).toMatchObject({ tick: 0, evacuated: 0, lost: 0 });
    expect(timeline.outcomesAt(world, 5_000)).toEqual({
      tick: 1,
      t_ms: 5_000,
      score: 42,
      extinguished: 2,
      active_fires: 1,
      evacuated: 1,
      lost: 1,
      houses_standing: 10,
      houses_destroyed: 1,
    });
  });

  it("builds chart series from every recorded tick", () => {
    const { scenario, timeline, addTick } = fixture();
    const initial = structuredClone(scenario.initial);
    const later = structuredClone(initial);
    later.tick = 1;
    later.score.extinguished = 3;
    later.fires = [];
    addTick(0, initial);
    addTick(1, later);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.outcomeSeries(world, "extinguished").map((point) => point.value)).toEqual([0, 3]);
    expect(timeline.outcomeSeries(world, "active_fires").map((point) => point.value)).toEqual([
      initial.fires.length,
      0,
    ]);
  });

  it("counts intensity-3 fire-ticks without two assigned firefighters", () => {
    const { scenario, timeline, addTick } = fixture();
    const uncovered = structuredClone(scenario.initial);
    uncovered.tick = 1;
    uncovered.fires = [{ ...uncovered.fires[0]!, intensity: 3 }];
    const covered = structuredClone(uncovered);
    covered.tick = 2;
    for (const firefighter of covered.agents.filter((agent) => agent.role === "firefighter")) {
      firefighter.order_status = "active";
      firefighter.order = {
        type: "extinguish",
        x: covered.fires[0]!.pos[0],
        y: covered.fires[0]!.pos[1],
      };
    }
    addTick(0, structuredClone(scenario.initial));
    addTick(1, uncovered);
    addTick(2, covered);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.counters(world, 5_000, 1).joint).toBe(1);
    expect(timeline.counters(world, 10_000, 2).joint).toBe(1);
  });
});
