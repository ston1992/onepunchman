import { contextBridge, ipcRenderer } from "electron";
import type { TaskEvent, TwinBridge } from "@shared/types";

const bridge: TwinBridge = {
  getProfile: () => ipcRenderer.invoke("twin:getProfile"),
  saveProfile: (profile) => ipcRenderer.invoke("twin:saveProfile", profile),
  listSamples: () => ipcRenderer.invoke("twin:listSamples"),
  addSample: (title, text) => ipcRenderer.invoke("twin:addSample", title, text),
  listTasks: () => ipcRenderer.invoke("task:list"),
  getTaskEvents: (taskId) => ipcRenderer.invoke("task:events", taskId),
  startTask: (prompt) => ipcRenderer.invoke("task:start", prompt),
  sendFollowUp: (taskId, text) => ipcRenderer.invoke("task:followUp", taskId, text),
  answerApproval: (taskId, toolUseId, allow) => ipcRenderer.invoke("task:approve", taskId, toolUseId, allow),
  stopTask: (taskId) => ipcRenderer.invoke("task:stop", taskId),
  openOutputs: (taskId) => ipcRenderer.invoke("task:openOutputs", taskId),
  onTaskEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, event: TaskEvent) => listener(event);
    ipcRenderer.on("task:event", handler);
    return () => ipcRenderer.removeListener("task:event", handler);
  },
};

contextBridge.exposeInMainWorld("twin", bridge);
