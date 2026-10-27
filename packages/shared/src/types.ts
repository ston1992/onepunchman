// Types shared by the main process, preload bridge and renderer.

export interface TwinProfile {
  name: string;
  role: string;
  company: string;
  /** How the user writes: tone, length, sign-off, words they avoid. */
  voice: string;
  /** Standing preferences: formats, tools, things to always / never do. */
  preferences: string;
}

export interface WritingSample {
  path: string;
  title: string;
}

export type TaskStatus = "starting" | "running" | "waiting_approval" | "idle" | "failed" | "stopped";

/** A simplified view of one session event, for rendering in the task timeline. */
export type TaskEvent =
  | { taskId: string; kind: "status"; status: TaskStatus; detail?: string }
  | { taskId: string; kind: "user"; id: string; text: string }
  | { taskId: string; kind: "message"; id: string; text: string }
  | { taskId: string; kind: "tool"; id: string; name: string; summary: string }
  | { taskId: string; kind: "approval"; id: string; name: string; summary: string }
  | { taskId: string; kind: "files"; files: OutputFile[] }
  | { taskId: string; kind: "error"; message: string };

export interface OutputFile {
  id: string;
  name: string;
  sizeBytes: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  createdAt: string;
  status: TaskStatus;
}

export type Plan = "free" | "pro";

export interface Account {
  email: string;
  emailVerified: boolean;
  plan: Plan;
  /** Model and sandbox spend this calendar month, in US cents at list price. */
  usageCents: number;
  limitCents: number;
  billingEnabled: boolean;
}

export interface AuthResponse {
  token: string;
  account: Account;
}

/** The API the preload script exposes on `window.twin`. */
export interface TwinBridge {
  getSession(): Promise<Account | null>;
  signUp(email: string, password: string): Promise<Account>;
  logIn(email: string, password: string): Promise<Account>;
  logOut(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resendVerification(): Promise<void>;
  deleteAccount(): Promise<void>;
  upgrade(): Promise<void>;
  manageBilling(): Promise<void>;
  openLegal(page: "terms" | "privacy"): Promise<void>;
  getProfile(): Promise<TwinProfile | null>;
  saveProfile(profile: TwinProfile): Promise<void>;
  listSamples(): Promise<WritingSample[]>;
  addSample(title: string, text: string): Promise<void>;
  listTasks(): Promise<TaskSummary[]>;
  getTaskEvents(taskId: string): Promise<TaskEvent[]>;
  startTask(prompt: string): Promise<TaskSummary>;
  sendFollowUp(taskId: string, text: string): Promise<void>;
  answerApproval(taskId: string, toolUseId: string, allow: boolean): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  openOutputs(taskId: string): Promise<void>;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}
