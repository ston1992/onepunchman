import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { TaskEvent, TaskStatus, TaskSummary } from "@shared/types";
import type { LocalState, StoredTask } from "./local-state";
import type { Twin } from "./twin";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;

export interface TaskRunnerConfig {
  agentId: string;
  environmentId: string;
  budgetCents: string;
  outputsRoot: string;
}

// Each task is one Managed Agents session: the agent loop and the sandbox both
// run in Anthropic's cloud, with the user's twin memory store mounted.
export class TaskRunner {
  private readonly seen = new Map<string, Set<string>>();
  private readonly pumping = new Set<string>();

  constructor(
    private readonly client: Anthropic,
    private readonly state: LocalState,
    private readonly twin: Twin,
    private readonly config: TaskRunnerConfig,
    private readonly emit: (event: TaskEvent) => void,
  ) {}

  list(): TaskSummary[] {
    return this.state.tasks.map(({ id, title, createdAt, status }) => ({ id, title, createdAt, status }));
  }

  events(taskId: string): TaskEvent[] {
    return this.state.task(taskId).events;
  }

  async start(prompt: string): Promise<TaskSummary> {
    if (!this.twin.storeId) throw new Error("Set up your twin profile before starting a task.");
    const session = await this.client.beta.sessions.create({
      agent: this.config.agentId,
      environment_id: this.config.environmentId,
      title: prompt.slice(0, 80),
      resources: [
        {
          type: "memory_store",
          memory_store_id: this.twin.storeId,
          access: "read_write",
          instructions: "This is you: read profile.md and the writing samples before working.",
        },
      ],
      budget: { type: "limit", max_list_cost: { amount: this.config.budgetCents, currency: "USD" } },
    });
    const task: StoredTask = {
      id: randomUUID(),
      sessionId: session.id,
      title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
      createdAt: new Date().toISOString(),
      status: "starting",
      events: [],
    };
    this.state.addTask(task);
    void this.sendMessage(task, prompt);
    return { id: task.id, title: task.title, createdAt: task.createdAt, status: task.status };
  }

  async followUp(taskId: string, text: string) {
    await this.sendMessage(this.state.task(taskId), text);
  }

  async answerApproval(taskId: string, toolUseId: string, allow: boolean) {
    const task = this.state.task(taskId);
    await this.client.beta.sessions.events.send(task.sessionId, {
      events: [{ type: "user.tool_confirmation", tool_use_id: toolUseId, result: allow ? "allow" : "deny" }],
    });
  }

  async stop(taskId: string) {
    const task = this.state.task(taskId);
    await this.client.beta.sessions.events.send(task.sessionId, { events: [{ type: "user.interrupt" }] });
  }

  outputDir(taskId: string) {
    return this.state.task(taskId).outputDir;
  }

  // Open the stream before sending, so no early event is missed. A task whose
  // stream is already open just gets the message queued.
  private async sendMessage(task: StoredTask, text: string) {
    const send = () =>
      this.client.beta.sessions.events.send(task.sessionId, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    if (this.pumping.has(task.id)) {
      await send();
      return;
    }
    this.pumping.add(task.id);
    try {
      if (!this.seen.has(task.id)) {
        // After an app restart: mark earlier turns as seen so a reconnect
        // replay doesn't mistake an old idle for this turn's end.
        const seen = new Set<string>();
        for await (const event of this.client.beta.sessions.events.list(task.sessionId)) seen.add(event.id);
        this.seen.set(task.id, seen);
      }
      const stream = await this.client.beta.sessions.events.stream(task.sessionId);
      await send();
      await this.pump(task, stream);
    } catch (err) {
      this.record(task, { taskId: task.id, kind: "error", message: errorMessage(err) });
      this.setStatus(task, "failed");
    } finally {
      this.pumping.delete(task.id);
    }
  }

  private async pump(task: StoredTask, stream: AsyncIterable<SessionEvent>) {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of stream) {
          if (await this.handle(task, event)) return;
        }
      } catch (err) {
        if (attempt >= 3) throw err;
      }
      // Dropped: reopen, then replay history we have not seen yet.
      stream = await this.client.beta.sessions.events.stream(task.sessionId);
      for await (const event of this.client.beta.sessions.events.list(task.sessionId)) {
        if (await this.handle(task, event)) return;
      }
    }
  }

  /** Returns true when the session settled and the stream can close. */
  private async handle(task: StoredTask, event: SessionEvent): Promise<boolean> {
    if ("id" in event && typeof event.id === "string") {
      const seen = this.seen.get(task.id) ?? new Set<string>();
      this.seen.set(task.id, seen);
      if (seen.has(event.id)) return false;
      seen.add(event.id);
    }

    switch (event.type) {
      case "session.status_running":
        this.setStatus(task, "running");
        return false;
      case "user.message":
        this.record(task, { taskId: task.id, kind: "user", id: event.id, text: textOf(event.content) });
        return false;
      case "agent.message":
        this.record(task, { taskId: task.id, kind: "message", id: event.id, text: textOf(event.content) });
        return false;
      case "agent.tool_use":
      case "agent.mcp_tool_use": {
        const summary = summarizeTool(event.name, event.input);
        if (event.evaluated_permission === "ask") {
          this.record(task, { taskId: task.id, kind: "approval", id: event.id, name: event.name, summary });
          this.setStatus(task, "waiting_approval");
        } else {
          this.record(task, { taskId: task.id, kind: "tool", id: event.id, name: event.name, summary });
        }
        return false;
      }
      case "session.error":
        this.record(task, { taskId: task.id, kind: "error", message: event.error.message });
        return false;
      case "session.status_idle":
        switch (event.stop_reason.type) {
          case "requires_action":
            return false;
          case "end_turn":
            await this.collectOutputs(task);
            this.setStatus(task, "idle");
            return true;
          case "budget_reached":
            this.setStatus(task, "stopped", "Reached this task's spend cap.");
            return true;
          case "refusal":
            this.setStatus(task, "stopped", "The model declined this request.");
            return true;
          default:
            this.setStatus(task, "failed", "The agent gave up after repeated errors.");
            return true;
        }
      case "session.status_terminated":
        this.setStatus(task, "stopped", "Session ended.");
        return true;
      default:
        return false;
    }
  }

  private async collectOutputs(task: StoredTask) {
    const dir = join(this.config.outputsRoot, task.id);
    // Outputs are indexed a moment after the session goes idle.
    for (let attempt = 0; attempt < 3; attempt++) {
      const names: string[] = [];
      for await (const file of this.client.beta.files.list({
        scope_id: task.sessionId,
        betas: ["managed-agents-2026-04-01"],
      })) {
        const response = await this.client.beta.files.download(file.id);
        mkdirSync(dir, { recursive: true });
        const name = basename(file.filename);
        writeFileSync(join(dir, name), Buffer.from(await response.arrayBuffer()));
        names.push(name);
      }
      if (names.length > 0) {
        task.outputDir = dir;
        this.record(task, { taskId: task.id, kind: "files", dir, names });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  private setStatus(task: StoredTask, status: TaskStatus, detail?: string) {
    task.status = status;
    this.record(task, { taskId: task.id, kind: "status", status, detail });
  }

  private record(task: StoredTask, event: TaskEvent) {
    if (event.kind !== "status") task.events.push(event);
    this.state.save();
    this.emit(event);
  }
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .trim();
}

function summarizeTool(name: string, input: Record<string, unknown>): string {
  const value = input.command ?? input.file_path ?? input.path ?? input.query ?? input.url ?? input.pattern;
  const text = typeof value === "string" ? value : JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status ?? ""} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}
