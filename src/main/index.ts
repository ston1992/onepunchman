import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import Anthropic from "@anthropic-ai/sdk";
import type { TwinProfile } from "@shared/types";
import { LocalState } from "./core/local-state";
import { TaskRunner } from "./core/tasks";
import { Twin } from "./core/twin";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and run npm run setup:cloud.`);
  return value;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Twinly",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: false },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

app.whenReady().then(() => {
  const client = new Anthropic();
  const state = LocalState.at(app.getPath("userData"));
  const twin = new Twin(client, state);
  const tasks = new TaskRunner(
    client,
    state,
    twin,
    {
      agentId: requireEnv("TWIN_AGENT_ID"),
      environmentId: requireEnv("TWIN_ENVIRONMENT_ID"),
      budgetCents: process.env.TWIN_TASK_BUDGET_CENTS || "500",
      outputsRoot: join(app.getPath("documents"), "Twinly"),
    },
    (event) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send("task:event", event)),
  );

  ipcMain.handle("twin:getProfile", () => twin.getProfile());
  ipcMain.handle("twin:saveProfile", (_e, profile: TwinProfile) => twin.saveProfile(profile));
  ipcMain.handle("twin:listSamples", () => twin.listSamples());
  ipcMain.handle("twin:addSample", (_e, title: string, text: string) => twin.addSample(title, text));
  ipcMain.handle("task:list", () => tasks.list());
  ipcMain.handle("task:events", (_e, taskId: string) => tasks.events(taskId));
  ipcMain.handle("task:start", (_e, prompt: string) => tasks.start(prompt));
  ipcMain.handle("task:followUp", (_e, taskId: string, text: string) => tasks.followUp(taskId, text));
  ipcMain.handle("task:approve", (_e, taskId: string, toolUseId: string, allow: boolean) =>
    tasks.answerApproval(taskId, toolUseId, allow),
  );
  ipcMain.handle("task:stop", (_e, taskId: string) => tasks.stop(taskId));
  ipcMain.handle("task:openOutputs", async (_e, taskId: string) => {
    const dir = tasks.outputDir(taskId);
    if (dir) await shell.openPath(dir);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
