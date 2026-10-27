import type Anthropic from "@anthropic-ai/sdk";

// In-memory stand-in for the Managed Agents surface the server uses. Each
// session replays a scripted agent turn whenever the user sends something.

type Event = { id: string; type: string; [key: string]: unknown };

interface FakeSession {
  id: string;
  events: Event[];
  listeners: Set<(e: Event) => void>;
  costCents: number;
  deleted: boolean;
  files: { id: string; filename: string; size_bytes: number; content: string }[];
  createParams: Record<string, unknown>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${++counter}`;

export class FakeAnthropic {
  readonly sessions = new Map<string, FakeSession>();
  /** When set, the next stream opened fails after delivering this many events. */
  failNextStreamAfter: number | null = null;
  /** Milliseconds between scripted agent events (0 in tests). */
  stepDelayMs = 0;
  readonly stores = new Map<string, Map<string, { id: string; path: string; content: string }>>();

  /** Agent reaction to each event the client sends. Override per test. */
  react: (session: FakeSession, sent: Event) => Event[] = (session, sent) => {
    if (sent.type === "user.message") {
      const text = (sent.content as { text: string }[])[0].text;
      if (text.includes("needs approval")) {
        return [
          { id: "", type: "session.status_running" },
          { id: "tool_ask", type: "agent.tool_use", name: "bash", input: { command: "pip install x" }, evaluated_permission: "ask" },
          { id: "", type: "session.status_idle", stop_reason: { type: "requires_action" } },
        ];
      }
      session.costCents += 120;
      session.files = [{ id: nextId("file"), filename: "report.md", size_bytes: 5, content: "hello" }];
      return [
        { id: "", type: "session.status_running" },
        { id: "", type: "agent.tool_use", name: "read", input: { file_path: "/mnt/memory/twin/profile.md" }, evaluated_permission: "allow" },
        { id: "", type: "agent.message", content: [{ type: "text", text: `Done: ${text}` }] },
        { id: "", type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ];
    }
    if (sent.type === "user.tool_confirmation") {
      session.costCents += 50;
      return [
        { id: "", type: "session.status_running" },
        { id: "", type: "agent.message", content: [{ type: "text", text: `Tool ${sent.result}` }] },
        { id: "", type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ];
    }
    return [];
  };

  private session(id: string): FakeSession {
    const session = this.sessions.get(id);
    if (!session || session.deleted) throw Object.assign(new Error("not found"), { status: 404 });
    return session;
  }

  private emit(session: FakeSession, event: Event) {
    const withId = { ...event, id: event.id || nextId("sevt"), processed_at: new Date().toISOString() };
    session.events.push(withId);
    for (const listener of session.listeners) listener(withId);
  }

  readonly beta = {
    sessions: {
      create: async (params: Record<string, unknown>) => {
        const session: FakeSession = {
          id: nextId("sesn"),
          events: [],
          listeners: new Set(),
          costCents: 0,
          deleted: false,
          files: [],
          createParams: params,
        };
        this.sessions.set(session.id, session);
        return { id: session.id };
      },
      retrieve: async (id: string) => {
        const session = this.session(id);
        return { id, usage: { list_cost: { amount: String(session.costCents), currency: "USD" } } };
      },
      delete: async (id: string) => {
        this.session(id).deleted = true;
        return { id };
      },
      events: {
        send: async (id: string, params: { events: Event[] }) => {
          const session = this.session(id);
          for (const sent of params.events) {
            this.emit(session, { ...sent, id: "" });
            const reactions = this.react(session, sent);
            reactions.forEach((e, i) => setTimeout(() => this.emit(session, e), this.stepDelayMs * (i + 1)));
          }
          return {};
        },
        stream: async (id: string) => {
          const session = this.session(id);
          const queue: Event[] = [];
          let wake: (() => void) | null = null;
          const listener = (e: Event) => {
            queue.push(e);
            wake?.();
          };
          session.listeners.add(listener);
          let failAfter = this.failNextStreamAfter;
          this.failNextStreamAfter = null;
          return {
            async *[Symbol.asyncIterator]() {
              try {
                while (!session.deleted) {
                  if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
                  wake = null;
                  while (queue.length) {
                    if (failAfter !== null && failAfter-- === 0) throw new Error("stream dropped");
                    yield queue.shift()!;
                  }
                }
              } finally {
                session.listeners.delete(listener);
              }
            },
          };
        },
        list: (id: string) => {
          const events = [...this.session(id).events];
          return (async function* () {
            yield* events;
          })();
        },
      },
    },
    memoryStores: {
      create: async () => {
        const id = nextId("memstore");
        this.stores.set(id, new Map());
        return { id };
      },
      delete: async (id: string) => {
        this.stores.delete(id);
        return { id };
      },
      memories: {
        list: (storeId: string, params: { path_prefix?: string }) => {
          const items = [...(this.stores.get(storeId)?.values() ?? [])]
            .filter((m) => m.path.startsWith(params.path_prefix ?? "/"))
            .map((m) => ({ type: "memory", id: m.id, path: m.path }));
          return (async function* () {
            yield* items;
          })();
        },
        retrieve: async (memoryId: string, params: { memory_store_id: string }) =>
          [...this.stores.get(params.memory_store_id)!.values()].find((m) => m.id === memoryId)!,
        create: async (storeId: string, params: { path: string; content: string }) => {
          const memory = { id: nextId("mem"), ...params };
          this.stores.get(storeId)!.set(params.path, memory);
          return memory;
        },
        update: async (memoryId: string, params: { memory_store_id: string; content: string }) => {
          const memory = [...this.stores.get(params.memory_store_id)!.values()].find((m) => m.id === memoryId)!;
          memory.content = params.content;
          return memory;
        },
      },
    },
    files: {
      list: (params: { scope_id: string }) => {
        const files = this.session(params.scope_id).files;
        return (async function* () {
          yield* files;
        })();
      },
      download: async (fileId: string) => {
        for (const session of this.sessions.values()) {
          const file = session.files.find((f) => f.id === fileId);
          if (file) return new Response(file.content);
        }
        throw new Error("no such file");
      },
    },
  };

  /** Seeds history directly, as if it happened while the server was down. */
  seed(sessionId: string, events: Event[]) {
    const session = this.session(sessionId);
    for (const event of events) this.emit(session, event);
  }

  asClient(): Anthropic {
    return this as unknown as Anthropic;
  }
}
