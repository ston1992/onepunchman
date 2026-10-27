import type { TaskEvent } from "@twinly/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// HTTP client for the Twinly server. Runs in the main process, so the auth
// token never reaches the renderer.
export class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | null,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
      throw new ApiError("Can't reach Twinly. Check your internet connection.", 0);
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    }
    return res.status === 204 || res.status === 202 ? (undefined as T) : ((await res.json()) as T);
  }

  async download(path: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(false) });
    if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Follows a task's server-sent events until `signal` aborts, reconnecting
   * with backoff when the connection drops.
   */
  async follow(taskId: string, onEvent: (event: TaskEvent) => void, signal: AbortSignal) {
    for (let delay = 1000; !signal.aborted; delay = Math.min(delay * 2, 30_000)) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/tasks/${taskId}/stream`, { headers: this.headers(false), signal });
        if (res.status === 401 || res.status === 404) return;
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        delay = 1000;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as TaskEvent);
            }
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (json) headers["content-type"] = "application/json";
    return headers;
  }
}
