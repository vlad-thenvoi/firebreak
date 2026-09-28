import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CodexAppServerClient,
  type CodexAppServerConnection,
  type DecideRequest,
  type RpcMessage,
} from "../src";

class FakeConnection implements CodexAppServerConnection {
  listener: ((message: RpcMessage) => void) | null = null;
  calls: { method: string; params: unknown }[] = [];
  responses: { id: number | string; result: unknown }[] = [];
  closed = false;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna" }] } as T;
    if (method === "thread/start")
      return {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        instructionSources: [],
      } as T;
    if (method === "turn/start") {
      queueMicrotask(() =>
        this.listener?.({
          method: "item/tool/call",
          id: 91,
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            tool: "move_to",
            arguments: { x: 3, y: 4 },
          },
        }),
      );
      return { turn: { id: "turn-1" } } as T;
    }
    if (method === "turn/interrupt") return {} as T;
    throw new Error(`unexpected request ${method}`);
  }

  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
    queueMicrotask(() => {
      this.listener?.({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 10,
              cacheWriteInputTokens: 5,
            },
          },
        },
      });
      this.listener?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", text: "moving" },
        },
      });
      this.listener?.({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
      });
    });
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("CodexAppServerClient", () => {
  it("uses a fresh ephemeral thread with only game tools and records subscription usage", async () => {
    const connection = new FakeConnection();
    const client = new CodexAppServerClient(
      "gpt-5.6-luna",
      { reasoningEffort: "low", maxTokens: 512 },
      async () => connection,
    );
    const execute = vi.fn().mockResolvedValue({ text: "accepted", isError: false });
    const req: DecideRequest = {
      system: "system",
      user: "observation",
      tools: [{ name: "move_to", description: "move", schema: { x: z.number(), y: z.number() } }],
      execute,
      maxTurns: 3,
      signal: new AbortController().signal,
    };

    const result = await client.decide(req);

    expect(execute).toHaveBeenCalledWith("move_to", { x: 3, y: 4 });
    const start = connection.calls.find((call) => call.method === "thread/start")!;
    expect(start.params as Record<string, unknown>).toMatchObject({
      model: "gpt-5.6-luna",
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "system",
      developerInstructions: "",
      dynamicTools: [{ type: "function", name: "move_to" }],
    });
    expect(connection.responses).toEqual([
      {
        id: 91,
        result: {
          contentItems: [{ type: "inputText", text: "accepted" }],
          success: true,
        },
      },
    ]);
    expect(result).toMatchObject({
      response: "moving",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 10,
      tool_calls: [{ name: "move_to", input: { x: 3, y: 4 }, result: "accepted" }],
      cost_estimated: true,
    });
    expect(result.cost_usd).toBeGreaterThan(0);

    await client.close();
    expect(connection.closed).toBe(true);
  });
});
