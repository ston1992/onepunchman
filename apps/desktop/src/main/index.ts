import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import type {
  Account,
  AuthResponse,
  OutputFile,
  TaskEvent,
  TaskSummary,
  TwinProfile,
  WritingSample,
} from "@twinly/shared";
import { Api, ApiError } from "./api";
import { TokenStore } from "./token-store";

declare const __API_URL__: string;
const API_URL = process.env.TWINLY_API_URL || __API_URL__;

const broadcast = (event: TaskEvent) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("task:event", event));

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Twinly",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
  });
  // Links (Stripe, legal pages) open in the user's browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith(API_URL)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  const tokens = new TokenStore(app.getPath("userData"));
  const api = new Api(API_URL, () => tokens.get());
  const following = new Map<string, AbortController>();

  const follow = (taskId: string) => {
    if (following.has(taskId)) return;
    const controller = new AbortController();
    following.set(taskId, controller);
    void api.follow(taskId, broadcast, controller.signal).finally(() => following.delete(taskId));
  };
  const stopFollowing = () => {
    for (const controller of following.values()) controller.abort();
    following.clear();
  };
  const signIn = (res: AuthResponse): Account => {
    tokens.set(res.token);
    return res.account;
  };

  // Errors cross IPC as plain messages; the renderer shows them as-is.
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...(args as A));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && tokens.get()) tokens.set(null);
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    });

  handle("auth:session", async () => {
    if (!tokens.get()) return null;
    try {
      return await api.request<Account>("GET", "/v1/account");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  });
  handle("auth:signUp", async (email: string, password: string) =>
    signIn(await api.request<AuthResponse>("POST", "/v1/auth/signup", { email, password })),
  );
  handle("auth:logIn", async (email: string, password: string) =>
    signIn(await api.request<AuthResponse>("POST", "/v1/auth/login", { email, password })),
  );
  handle("auth:forgot", (email: string) => api.request("POST", "/v1/auth/forgot", { email }));
  handle("auth:resendVerification", () => api.request("POST", "/v1/account/verification"));
  handle("auth:logOut", async () => {
    stopFollowing();
    tokens.set(null);
  });
  handle("account:delete", async () => {
    await api.request("DELETE", "/v1/account");
    stopFollowing();
    tokens.set(null);
  });
  handle("billing:upgrade", async () => {
    const { url } = await api.request<{ url: string }>("POST", "/v1/billing/checkout");
    await shell.openExternal(url);
  });
  handle("billing:manage", async () => {
    const { url } = await api.request<{ url: string }>("POST", "/v1/billing/portal");
    await shell.openExternal(url);
  });

  handle("legal:open", (page: "terms" | "privacy") => shell.openExternal(`${API_URL}/${page}`));

  handle("twin:getProfile", async () => (await api.request<{ profile: TwinProfile | null }>("GET", "/v1/twin/profile")).profile);
  handle("twin:saveProfile", (profile: TwinProfile) => api.request("PUT", "/v1/twin/profile", profile));
  handle("twin:listSamples", async () => (await api.request<{ samples: WritingSample[] }>("GET", "/v1/twin/samples")).samples);
  handle("twin:addSample", (title: string, text: string) => api.request("POST", "/v1/twin/samples", { title, text }));

  handle("task:list", async () => (await api.request<{ tasks: TaskSummary[] }>("GET", "/v1/tasks")).tasks);
  handle("task:events", async (taskId: string) => {
    follow(taskId); // subscribe before fetching history so nothing falls in between
    return (await api.request<{ events: TaskEvent[] }>("GET", `/v1/tasks/${taskId}/events`)).events;
  });
  handle("task:start", async (prompt: string) => {
    const { task } = await api.request<{ task: TaskSummary }>("POST", "/v1/tasks", { prompt });
    follow(task.id);
    return task;
  });
  handle("task:followUp", (taskId: string, text: string) => api.request("POST", `/v1/tasks/${taskId}/messages`, { text }));
  handle("task:approve", (taskId: string, toolUseId: string, allow: boolean) =>
    api.request("POST", `/v1/tasks/${taskId}/approvals`, { toolUseId, allow }),
  );
  handle("task:stop", (taskId: string) => api.request("POST", `/v1/tasks/${taskId}/stop`));
  handle("task:openOutputs", async (taskId: string) => {
    const { files } = await api.request<{ files: OutputFile[] }>("GET", `/v1/tasks/${taskId}/files`);
    const dir = join(app.getPath("documents"), "Twinly", taskId.slice(0, 8));
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, basename(file.name)), await api.download(`/v1/tasks/${taskId}/files/${file.id}`));
    }
    await shell.openPath(dir);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
