import { DatabaseSync } from "node:sqlite";
import type { Plan, TaskEvent, TaskStatus } from "@twinly/shared";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  plan: Plan;
  stripe_customer_id: string | null;
  memory_store_id: string | null;
  email_verified: number;
  created_at: string;
}

export type TokenPurpose = "verify_email" | "reset_password";

export interface TaskRow {
  id: string;
  user_id: string;
  session_id: string;
  title: string;
  status: TaskStatus;
  /** Spend cap set on the session; reserved against the user's allowance until it settles. */
  budget_cents: number;
  cost_cents: number;
  /** ID of the last session event handled, for catching up after a restart. */
  cursor: string | null;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT UNIQUE,
  memory_store_id TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  budget_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, created_at);
CREATE TABLE IF NOT EXISTS task_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, seq);
`;

// Thin typed wrapper over SQLite. One file, one process: fine for launch; move
// to Postgres when you run more than one server instance.
export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  createUser(user: Pick<UserRow, "id" | "email" | "password_hash" | "email_verified">): UserRow {
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, email_verified, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.email, user.password_hash, user.email_verified, new Date().toISOString());
    return this.userById(user.id)!;
  }

  userById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  userByEmail(email: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  }

  userByStripeCustomer(customerId: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").get(customerId) as
      | UserRow
      | undefined;
  }

  updateUser(
    id: string,
    fields: Partial<Pick<UserRow, "plan" | "stripe_customer_id" | "memory_store_id" | "email_verified" | "password_hash">>,
  ) {
    for (const [key, value] of Object.entries(fields)) {
      this.db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(value ?? null, id);
    }
  }

  /** Stores a single-use token (by hash), replacing any earlier one for the same purpose. */
  saveToken(hash: string, userId: string, purpose: TokenPurpose, expiresAt: string) {
    this.db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?").run(userId, purpose);
    this.db.prepare("INSERT INTO auth_tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)").run(hash, userId, purpose, expiresAt);
  }

  /** Returns the user ID and deletes the token if it is valid, unexpired and for `purpose`. */
  consumeToken(hash: string, purpose: TokenPurpose): string | null {
    const row = this.db.prepare("SELECT * FROM auth_tokens WHERE hash = ? AND purpose = ?").get(hash, purpose) as
      | { user_id: string; expires_at: string }
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM auth_tokens WHERE hash = ?").run(hash);
    return row.expires_at > new Date().toISOString() ? row.user_id : null;
  }

  deleteUser(id: string) {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  createTask(task: TaskRow) {
    this.db
      .prepare(
        "INSERT INTO tasks (id, user_id, session_id, title, status, budget_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(task.id, task.user_id, task.session_id, task.title, task.status, task.budget_cents, task.created_at);
  }

  task(id: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  tasksForUser(userId: string): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC").all(userId) as unknown as TaskRow[];
  }

  unsettledTasks(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status IN ('starting', 'running', 'waiting_approval')")
      .all() as unknown as TaskRow[];
  }

  updateTask(id: string, fields: Partial<Pick<TaskRow, "status" | "cost_cents" | "cursor">>) {
    for (const [key, value] of Object.entries(fields)) {
      this.db.prepare(`UPDATE tasks SET ${key} = ? WHERE id = ?`).run(value ?? null, id);
    }
  }

  /**
   * List-price spend on tasks created since `since` (ISO timestamp). With
   * `reserve`, tasks still running count at their full budget, so parallel
   * tasks can't overrun the allowance before their costs come in.
   */
  usageCents(userId: string, since: string, reserve = false): number {
    const amount = reserve
      ? "CASE WHEN status IN ('starting', 'running', 'waiting_approval') THEN MAX(cost_cents, budget_cents) ELSE cost_cents END"
      : "cost_cents";
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(${amount}), 0) AS total FROM tasks WHERE user_id = ? AND created_at >= ?`)
      .get(userId, since) as { total: number };
    return row.total;
  }

  addEvent(taskId: string, event: TaskEvent) {
    this.db.prepare("INSERT INTO task_events (task_id, body) VALUES (?, ?)").run(taskId, JSON.stringify(event));
  }

  events(taskId: string): TaskEvent[] {
    return (
      this.db.prepare("SELECT body FROM task_events WHERE task_id = ? ORDER BY seq").all(taskId) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as TaskEvent);
  }

  close() {
    this.db.close();
  }
}
