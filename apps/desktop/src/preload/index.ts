import { contextBridge, ipcRenderer } from "electron";
import type { TaskEvent, TwinBridge } from "@twinly/shared";

// Electron prefixes errors thrown across IPC; keep only the message itself.
const invoke = async (channel: string, ...args: unknown[]) => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
};

const bridge: TwinBridge = {
  getSession: () => invoke("auth:session"),
  signUp: (email, password) => invoke("auth:signUp", email, password),
  logIn: (email, password) => invoke("auth:logIn", email, password),
  logOut: () => invoke("auth:logOut"),
  forgotPassword: (email) => invoke("auth:forgot", email),
  resendVerification: () => invoke("auth:resendVerification"),
  deleteAccount: () => invoke("account:delete"),
  upgrade: () => invoke("billing:upgrade"),
  manageBilling: () => invoke("billing:manage"),
  openLegal: (page) => invoke("legal:open", page),
  getProfile: () => invoke("twin:getProfile"),
  saveProfile: (profile) => invoke("twin:saveProfile", profile),
  listSamples: () => invoke("twin:listSamples"),
  addSample: (title, text) => invoke("twin:addSample", title, text),
  listTasks: () => invoke("task:list"),
  getTaskEvents: (taskId) => invoke("task:events", taskId),
  startTask: (prompt) => invoke("task:start", prompt),
  sendFollowUp: (taskId, text) => invoke("task:followUp", taskId, text),
  answerApproval: (taskId, toolUseId, allow) => invoke("task:approve", taskId, toolUseId, allow),
  stopTask: (taskId) => invoke("task:stop", taskId),
  openOutputs: (taskId) => invoke("task:openOutputs", taskId),
  onTaskEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: TaskEvent) => listener(event);
    ipcRenderer.on("task:event", handler);
    return () => ipcRenderer.removeListener("task:event", handler);
  },
};

contextBridge.exposeInMainWorld("twin", bridge);
