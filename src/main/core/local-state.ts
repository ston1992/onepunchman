import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskEvent, TaskSummary } from "@shared/types";

// Small JSON file in the app's userData folder. Holds IDs that point at cloud
// state; the twin's content itself lives in the memory store.

export interface StoredTask extends TaskSummary {
  sessionId: string;
  outputDir?: string;
  events: TaskEvent[];
}

interface State {
  memoryStoreId?: string;
  tasks: StoredTask[];
}

export class LocalState {
  private state: State;

  constructor(private readonly file: string) {
    this.state = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : { tasks: [] };
  }

  get memoryStoreId() {
    return this.state.memoryStoreId;
  }

  set memoryStoreId(id: string | undefined) {
    this.state.memoryStoreId = id;
    this.save();
  }

  get tasks(): StoredTask[] {
    return this.state.tasks;
  }

  task(id: string): StoredTask {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Unknown task ${id}`);
    return task;
  }

  addTask(task: StoredTask) {
    this.state.tasks.unshift(task);
    this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  static at(userDataDir: string) {
    return new LocalState(join(userDataDir, "twinly-state.json"));
  }
}
