import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { OutputFile, TaskEvent, TaskStatus, TaskSummary } from "@twinly/shared";
import { MIN_TASK_BUDGET_CENTS, type Config } from "./config";
import type { Db, TaskRow, UserRow } from "./db";
import { remainingCents } from "./usage";

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;

export class QuotaError extends Error {}

const SETTLED: TaskStatus[] = ["idle", "failed", "stopped"];

// Each task is one Managed Agents session: the agent loop and the sandbox both
// run in Anthropic's cloud, with the user's twin memory store mounted. The
// server holds one event stream per active session and fans events out to
// connected desktop clients.
export class TaskService {
  private readonly bus = new EventEmitter();
  private readonly seen = new Map<string, Set<string>>();
  private readonly pumping = new Set<string>();

  constructor(
    private readonly client: Anthropic,
    private readonly db: Db,
    private readonly config: Pick<Config, "agentId" | "environmentId" | "taskBudgetCents">,
  ) {
    this.bus.setMaxListeners(0);
  }

  async start(user: UserRow, prompt: string): Promise<TaskSummary> {
    if (!user.memory_store_id) throw new QuotaError("Set up your twin profile before starting a task.");
    const remaining = remainingCents(this.db, user);
    if (remaining < MIN_TASK_BUDGET_CENTS) throw new QuotaError("You've used this month's allowance. Upgrade to keep going.");

    const budget = Math.min(this.config.taskBudgetCents, remaining);
    const session = await this.client.beta.sessions.create({
      agent: this.config.agentId,
      environment_id: this.config.environmentId,
      title: prompt.slice(0, 80),
      metadata: { user_id: user.id },
      resources: [
        {
          type: "memory_store",
          memory_store_id: user.memory_store_id,
          access: "read_write",
          instructions: "This is you: read profile.md and the writing samples before working.",
        },
      ],
      budget: { type: "limit", max_list_cost: { amount: String(budget), currency: "USD" } },
    });
    const task: TaskRow = {
      id: randomUUID(),
      user_id: user.id,
      session_id: session.id,
      title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
      status: "starting",
      budget_cents: budget,
      cost_cents: 0,
      cursor: null,
      created_at: new Date().toISOString(),
    };
    this.db.createTask(task);
    void this.sendMessage(task, prompt);
    return summarize(task);
  }

  async followUp(user: UserRow, task: TaskRow, text: string) {
    if (remainingCents(this.db, user) < MIN_TASK_BUDGET_CENTS) {
      throw new QuotaError("You've used this month's allowance. Upgrade to keep going.");
    }
    await this.sendMessage(task, text);
  }

  async answerApproval(task: TaskRow, toolUseId: string, allow: boolean) {
    await this.client.beta.sessions.events.send(task.session_id, {
      events: [{ type: "user.tool_confirmation", tool_use_id: toolUseId, result: allow ? "allow" : "deny" }],
    });
  }

  async stop(task: TaskRow) {
    await this.client.beta.sessions.events.send(task.session_id, { events: [{ type: "user.interrupt" }] });
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.bus.on(taskId, listener);
    return () => this.bus.off(taskId, listener);
  }

  async files(task: TaskRow): Promise<OutputFile[]> {
    const files: OutputFile[] = [];
    for await (const file of this.client.beta.files.list({
      scope_id: task.session_id,
      betas: ["managed-agents-2026-04-01"],
    })) {
      files.push({ id: file.id, name: file.filename, sizeBytes: file.size_bytes });
    }
    return files;
  }

  /** Downloads one output file, after checking it belongs to this task's session. */
  async download(task: TaskRow, fileId: string): Promise<{ name: string; body: Response } | null> {
    const file = (await this.files(task)).find((f) => f.id === fileId);
    if (!file) return null;
    return { name: file.name, body: await this.client.beta.files.download(fileId) };
  }

  /** Deletes the cloud sessions behind a user's tasks (account deletion). */
  async destroyAll(userId: string) {
    for (const task of this.db.tasksForUser(userId)) {
      await this.client.beta.sessions.delete(task.session_id).catch((err: unknown) => {
        if (!(err instanceof Anthropic.NotFoundError)) throw err;
      });
    }
  }

  /** After a server restart, reattach to sessions that were still working. */
  resumeUnsettled() {
    for (const task of this.db.unsettledTasks()) void this.attach(task);
  }

  private async attach(task: TaskRow) {
    if (this.pumping.has(task.id)) return;
    this.pumping.add(task.id);
    try {
      const stream = await this.client.beta.sessions.events.stream(task.session_id);
      if (await this.replay(task)) return;
      await this.pump(task, stream);
    } catch (err) {
      this.fail(task, err);
    } finally {
      this.pumping.delete(task.id);
    }
  }

  // Open the stream before sending, so no early event is missed. A task whose
  // stream is already open just gets the message queued.
  private async sendMessage(task: TaskRow, text: string) {
    const send = () =>
      this.client.beta.sessions.events.send(task.session_id, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    if (this.pumping.has(task.id)) {
      await send();
      return;
    }
    this.pumping.add(task.id);
    try {
      const stream = await this.client.beta.sessions.events.stream(task.session_id);
      await send();
      await this.pump(task, stream);
    } catch (err) {
      this.fail(task, err);
    } finally {
      this.pumping.delete(task.id);
    }
  }

  private async pump(task: TaskRow, stream: AsyncIterable<SessionEvent>) {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of stream) {
          if (await this.handle(task, event)) return;
        }
      } catch (err) {
        if (attempt >= 3) throw err;
      }
      // Dropped: reopen, then catch up on whatever happened in the gap.
      stream = await this.client.beta.sessions.events.stream(task.session_id);
      if (await this.replay(task)) return;
    }
  }

  /** Handles history after the task's cursor. Returns true if the session settled. */
  private async replay(task: TaskRow): Promise<boolean> {
    const cursor = this.db.task(task.id)?.cursor ?? null;
    let past = cursor === null;
    for await (const event of this.client.beta.sessions.events.list(task.session_id)) {
      if (!past) {
        past = event.id === cursor;
        continue;
      }
      if (await this.handle(task, event)) return true;
    }
    return false;
  }

  /** Returns true when the session settled and the stream can close. */
  private async handle(task: TaskRow, event: SessionEvent): Promise<boolean> {
    if ("id" in event && typeof event.id === "string") {
      const seen = this.seen.get(task.id) ?? new Set<string>();
      this.seen.set(task.id, seen);
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      this.db.updateTask(task.id, { cursor: event.id });
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
        const summary = summarizeTool(event.input);
        if (event.evaluated_permission === "ask") {
          this.record(task, { taskId: task.id, kind: "approval", id: event.id, name: event.name, summary });
          this.setStatus(task, "waiting_approval");
        } else {
          this.record(task, { taskId: task.id, kind: "tool", id: event.id, name: event.name, summary });
        }
        return false;
      }
      case "user.tool_confirmation":
        if (this.db.task(task.id)?.status === "waiting_approval") this.setStatus(task, "running");
        return false;
      case "session.error":
        this.record(task, { taskId: task.id, kind: "error", message: event.error.message });
        return false;
      case "session.status_idle":
        switch (event.stop_reason.type) {
          case "requires_action":
            return false;
          case "end_turn": {
            const files = await this.files(task).catch(() => []);
            if (files.length > 0) this.record(task, { taskId: task.id, kind: "files", files });
            await this.settle(task, "idle");
            return true;
          }
          case "budget_reached":
            await this.settle(task, "stopped", "Reached this task's spend cap.");
            return true;
          case "refusal":
            await this.settle(task, "stopped", "The model declined this request.");
            return true;
          default:
            await this.settle(task, "failed", "The agent gave up after repeated errors.");
            return true;
        }
      case "session.status_terminated":
        await this.settle(task, "stopped", "Session ended.");
        return true;
      default:
        return false;
    }
  }

  private async settle(task: TaskRow, status: TaskStatus, detail?: string) {
    try {
      const session = await this.client.beta.sessions.retrieve(task.session_id);
      const cost = Number(session.usage.list_cost?.amount ?? 0);
      if (Number.isFinite(cost)) this.db.updateTask(task.id, { cost_cents: Math.ceil(cost) });
    } catch {
      // Cost is refreshed again on the next settle; never block the user on it.
    }
    this.setStatus(task, status, detail);
  }

  private fail(task: TaskRow, err: unknown) {
    this.record(task, { taskId: task.id, kind: "error", message: errorMessage(err) });
    this.setStatus(task, "failed");
  }

  private setStatus(task: TaskRow, status: TaskStatus, detail?: string) {
    this.db.updateTask(task.id, { status });
    this.bus.emit(task.id, { taskId: task.id, kind: "status", status, detail } satisfies TaskEvent);
  }

  private record(task: TaskRow, event: TaskEvent) {
    this.db.addEvent(task.id, event);
    this.bus.emit(task.id, event);
  }
}

export function summarize(task: TaskRow): TaskSummary {
  return { id: task.id, title: task.title, createdAt: task.created_at, status: task.status };
}

export function isSettled(status: TaskStatus) {
  return SETTLED.includes(status);
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .trim();
}

function summarizeTool(input: Record<string, unknown>): string {
  const value = input.command ?? input.file_path ?? input.path ?? input.query ?? input.url ?? input.pattern;
  const text = typeof value === "string" ? value : JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.APIError) return "The cloud workspace had a problem. Please try again.";
  return err instanceof Error ? err.message : String(err);
}
