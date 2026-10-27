import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import type { TaskEvent, TaskSummary } from "@twinly/shared";
import { buildApp } from "../src/app";
import { Tokens } from "../src/auth";
import { Billing } from "../src/billing";
import { Db } from "../src/db";
import { TaskService } from "../src/tasks";
import { FakeAnthropic } from "./fake-anthropic";

const WEBHOOK_SECRET = "whsec_test_secret";
const config = { agentId: "agent_1", environmentId: "env_1", taskBudgetCents: 500 };

type SentEmail = { to: string; subject: string; link: string };

async function setup(opts: { mailer?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const mailer = opts.mailer
    ? {
        send: async (to: string, subject: string, html: string) => {
          sent.push({ to, subject, link: html.match(/href="([^"]+)"/)![1] });
        },
      }
    : undefined;
  const db = new Db(":memory:");
  const fake = new FakeAnthropic();
  const tasks = new TaskService(fake.asClient(), db, config);
  const stripe = new Stripe("sk_test_dummy");
  const billing = new Billing(
    { secretKey: "sk_test_dummy", webhookSecret: WEBHOOK_SECRET, proPriceId: "price_pro", publicUrl: "http://x" },
    db,
    stripe,
  );
  const app = await buildApp({
    db,
    anthropic: fake.asClient(),
    tokens: new Tokens("x".repeat(40)),
    tasks,
    billing,
    mailer,
    publicUrl: "https://api.test",
  });

  async function call(method: string, url: string, token?: string, body?: unknown) {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });
    const isJson = String(res.headers["content-type"] ?? "").includes("application/json");
    return { status: res.statusCode, json: isJson ? JSON.parse(res.body) : undefined, raw: res };
  }

  async function signUp(email: string) {
    const res = await call("POST", "/v1/auth/signup", undefined, { email, password: "correct horse battery" });
    assert.equal(res.status, 201);
    return res.json.token as string;
  }

  async function withTwin(email: string) {
    const token = await signUp(email);
    const res = await call("PUT", "/v1/twin/profile", token, {
      name: "Alex Kim",
      role: "PMM",
      company: "Acme",
      voice: "Direct.",
      preferences: "Tables.",
    });
    assert.equal(res.status, 204);
    return token;
  }

  async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, label = "condition"): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const value = await fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function taskStatus(token: string, id: string) {
    const res = await call("GET", "/v1/tasks", token);
    return (res.json.tasks as TaskSummary[]).find((t) => t.id === id)?.status;
  }

  return { db, fake, tasks, stripe, app, call, signUp, withTwin, waitFor, taskStatus, sent };
}

describe("auth", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup()));
  after(() => t.app.close());

  test("sign up, log in, and reject bad credentials", async () => {
    await t.signUp("Alex@Example.com");
    assert.equal((await t.call("POST", "/v1/auth/signup", undefined, { email: "alex@example.com", password: "another password" })).status, 409);
    const login = await t.call("POST", "/v1/auth/login", undefined, { email: "alex@example.com", password: "correct horse battery" });
    assert.equal(login.status, 200);
    assert.equal(login.json.account.email, "alex@example.com");
    assert.equal(login.json.account.plan, "free");
    assert.equal((await t.call("POST", "/v1/auth/login", undefined, { email: "alex@example.com", password: "wrong password!" })).status, 401);
  });

  test("short passwords and missing or forged tokens are rejected", async () => {
    assert.equal((await t.call("POST", "/v1/auth/signup", undefined, { email: "b@example.com", password: "short" })).status, 400);
    assert.equal((await t.call("GET", "/v1/account")).status, 401);
    assert.equal((await t.call("GET", "/v1/account", "not-a-token")).status, 401);
    const forged = await new Tokens("y".repeat(40)).issue("someone", "hash");
    assert.equal((await t.call("GET", "/v1/account", forged)).status, 401);
  });
});

describe("email verification and password reset", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup({ mailer: true })));
  after(() => t.app.close());

  const path = (link: string) => link.replace("https://api.test", "");

  test("new accounts must confirm their email before running tasks", async () => {
    const token = await t.withTwin("verify@example.com");
    assert.equal((await t.call("GET", "/v1/account", token)).json.emailVerified, false);
    assert.equal((await t.call("POST", "/v1/tasks", token, { prompt: "Work" })).status, 403);

    const email = t.sent.find((m) => m.to === "verify@example.com")!;
    assert.match(email.subject, /Confirm/);
    const page = await t.app.inject({ method: "GET", url: path(email.link) });
    assert.match(page.body, /Email confirmed/);
    const reused = await t.app.inject({ method: "GET", url: path(email.link) });
    assert.match(reused.body, /expired/, "links are single-use");

    assert.equal((await t.call("GET", "/v1/account", token)).json.emailVerified, true);
    assert.equal((await t.call("POST", "/v1/tasks", token, { prompt: "Work" })).status, 201);
  });

  test("password reset works once, signs out old sessions, and doesn't reveal accounts", async () => {
    const oldToken = await t.signUp("reset@example.com");
    assert.equal((await t.call("POST", "/v1/auth/forgot", undefined, { email: "nobody@example.com" })).status, 202);
    assert.equal(t.sent.some((m) => m.to === "nobody@example.com"), false);

    assert.equal((await t.call("POST", "/v1/auth/forgot", undefined, { email: "reset@example.com" })).status, 202);
    const email = t.sent.filter((m) => m.to === "reset@example.com").at(-1)!;
    assert.match(email.subject, /Reset/);
    const token = new URL(email.link).searchParams.get("token")!;
    const form = await t.app.inject({ method: "GET", url: path(email.link) });
    assert.match(form.body, /Choose a new password/);

    assert.equal((await t.call("POST", "/v1/auth/reset", undefined, { token, password: "brand new password" })).status, 204);
    assert.equal((await t.call("POST", "/v1/auth/reset", undefined, { token, password: "another new password" })).status, 400);
    assert.equal((await t.call("GET", "/v1/account", oldToken)).status, 401, "old sessions are signed out");
    const login = await t.call("POST", "/v1/auth/login", undefined, { email: "reset@example.com", password: "brand new password" });
    assert.equal(login.status, 200);
    assert.equal(login.json.account.emailVerified, true, "the reset link also proves the address");
  });
});

describe("twin", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup()));
  after(() => t.app.close());

  test("profile and samples round-trip through the memory store", async () => {
    const token = await t.signUp("twin@example.com");
    assert.equal((await t.call("GET", "/v1/twin/profile", token)).json.profile, null);
    const profile = { name: "Alex Kim", role: "PMM", company: "Acme", voice: "Short.\nNo emojis.", preferences: "Tables." };
    await t.call("PUT", "/v1/twin/profile", token, profile);
    assert.deepEqual((await t.call("GET", "/v1/twin/profile", token)).json.profile, profile);
    await t.call("PUT", "/v1/twin/profile", token, { ...profile, role: "Director" });
    assert.equal((await t.call("GET", "/v1/twin/profile", token)).json.profile.role, "Director");
    assert.equal(t.fake.stores.size, 1, "profile updates reuse one store");

    await t.call("POST", "/v1/twin/samples", token, { title: "Q3 Launch Email!", text: "Hi team..." });
    const samples = (await t.call("GET", "/v1/twin/samples", token)).json.samples;
    assert.deepEqual(samples, [{ path: "/writing-samples/q3-launch-email.md", title: "q3-launch-email" }]);
  });
});

describe("tasks", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup()));
  after(() => t.app.close());

  test("a task needs a twin first", async () => {
    const token = await t.signUp("notwin@example.com");
    const res = await t.call("POST", "/v1/tasks", token, { prompt: "Write my update" });
    assert.equal(res.status, 402);
  });

  test("runs to completion, records the timeline, cost and output files", async () => {
    const token = await t.withTwin("run@example.com");
    const res = await t.call("POST", "/v1/tasks", token, { prompt: "Write my weekly update" });
    assert.equal(res.status, 201);
    const task = res.json.task as TaskSummary;

    const session = [...t.fake.sessions.values()].at(-1)!;
    const params = session.createParams as { budget: { max_list_cost: { amount: string } }; resources: { type: string }[] };
    assert.equal(params.budget.max_list_cost.amount, "200", "budget is capped by the free allowance");
    assert.equal(params.resources[0].type, "memory_store");

    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "idle", "idle");
    const events = (await t.call("GET", `/v1/tasks/${task.id}/events`, token)).json.events as TaskEvent[];
    assert.deepEqual(
      events.map((e) => e.kind),
      ["user", "tool", "message", "files"],
    );
    const files = events.find((e) => e.kind === "files");
    assert.ok(files && files.kind === "files");
    const download = await t.call("GET", `/v1/tasks/${task.id}/files/${files.files[0].id}`, token);
    assert.equal(download.status, 200);
    assert.equal(download.raw.body, "hello");

    const account = (await t.call("GET", "/v1/account", token)).json;
    assert.equal(account.usageCents, 120);
    assert.equal(account.limitCents, 200);
  });

  test("approvals pause the task until the user answers", async () => {
    const token = await t.withTwin("approve@example.com");
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "This needs approval" })).json.task as TaskSummary;
    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "waiting_approval", "approval");
    const events = (await t.call("GET", `/v1/tasks/${task.id}/events`, token)).json.events as TaskEvent[];
    const approval = events.find((e) => e.kind === "approval");
    assert.ok(approval && approval.kind === "approval");
    assert.equal(approval.summary, "pip install x");

    const res = await t.call("POST", `/v1/tasks/${task.id}/approvals`, token, { toolUseId: approval.id, allow: false });
    assert.equal(res.status, 202);
    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "idle", "idle after approval");
    const final = (await t.call("GET", `/v1/tasks/${task.id}/events`, token)).json.events as TaskEvent[];
    assert.ok(final.some((e) => e.kind === "message" && e.text === "Tool deny"));
  });

  test("follow-ups continue the same session", async () => {
    const token = await t.withTwin("follow@example.com");
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "First draft" })).json.task as TaskSummary;
    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "idle");
    assert.equal((await t.call("POST", `/v1/tasks/${task.id}/messages`, token, { text: "Shorter please" })).status, 202);
    await t.waitFor(async () => {
      const events = (await t.call("GET", `/v1/tasks/${task.id}/events`, token)).json.events as TaskEvent[];
      return events.some((e) => e.kind === "message" && e.text === "Done: Shorter please");
    }, "follow-up reply");
  });

  test("users cannot see or touch each other's tasks", async () => {
    const owner = await t.withTwin("owner@example.com");
    const other = await t.withTwin("other@example.com");
    const task = (await t.call("POST", "/v1/tasks", owner, { prompt: "Private work" })).json.task as TaskSummary;
    for (const [method, path, body] of [
      ["GET", "events", undefined],
      ["GET", "files", undefined],
      ["GET", "stream", undefined],
      ["POST", "messages", { text: "hi" }],
      ["POST", "approvals", { toolUseId: "x", allow: true }],
      ["POST", "stop", undefined],
    ] as const) {
      assert.equal((await t.call(method, `/v1/tasks/${task.id}/${path}`, other, body)).status, 404, `${method} ${path}`);
    }
    assert.equal((await t.call("GET", "/v1/tasks", other)).json.tasks.length, 0);
  });

  test("the monthly allowance blocks new work, counting running tasks at their budget", async () => {
    const token = await t.withTwin("quota@example.com");
    const budgetOfLastSession = () =>
      ([...t.fake.sessions.values()].at(-1)!.createParams as { budget: { max_list_cost: { amount: string } } }).budget
        .max_list_cost.amount;

    // A task waiting on approval reserves its whole $2 budget.
    const first = (await t.call("POST", "/v1/tasks", token, { prompt: "This needs approval" })).json.task as TaskSummary;
    await t.waitFor(async () => (await t.taskStatus(token, first.id)) === "waiting_approval");
    assert.equal((await t.call("POST", "/v1/tasks", token, { prompt: "Blocked" })).status, 402);

    // Once it settles at $0.50, the rest of the allowance is usable again.
    await t.call("POST", `/v1/tasks/${first.id}/approvals`, token, { toolUseId: "tool_ask", allow: true });
    await t.waitFor(async () => (await t.taskStatus(token, first.id)) === "idle");
    const budgets: string[] = [];
    for (;;) {
      const res = await t.call("POST", "/v1/tasks", token, { prompt: "More work" });
      if (res.status === 402) break;
      budgets.push(budgetOfLastSession());
      await t.waitFor(async () => (await t.taskStatus(token, res.json.task.id)) === "idle");
    }
    assert.deepEqual(budgets, ["150", "30"], "each task is capped by what is left");
    assert.equal((await t.call("POST", `/v1/tasks/${first.id}/messages`, token, { text: "More" })).status, 402);
  });

  test("a dropped cloud stream is reopened without losing or repeating events", async () => {
    const token = await t.withTwin("drop@example.com");
    t.fake.failNextStreamAfter = 2; // drop right after the user message and running status
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "Flaky network" })).json.task as TaskSummary;
    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "idle", "idle after reconnect");
    assert.deepEqual(
      t.db.events(task.id).map((e) => e.kind),
      ["user", "tool", "message", "files"],
    );
  });

  test("desktop clients get live events over server-sent events", async () => {
    const token = await t.withTwin("sse@example.com");
    t.fake.react = () => []; // events arrive only when the test seeds them
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "Quiet start" })).json.task as TaskSummary;
    const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/v1/tasks/${task.id}/stream`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const sessionId = t.db.task(task.id)!.session_id;
    t.fake.seed(sessionId, [{ id: "", type: "agent.message", content: [{ type: "text", text: "live!" }] }]);
    let text = "";
    while (!text.includes("live!")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(text, /^data: \{"taskId":".*","kind":"status"/);
    assert.match(text, /"kind":"message","id":"sevt_\d+","text":"live!"/);
  });

  test("after a restart, unsettled tasks catch up from session history", async () => {
    const token = await t.withTwin("restart@example.com");
    t.fake.react = () => []; // the agent goes quiet: the server "dies" mid-task
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "Long job" })).json.task as TaskSummary;
    await t.waitFor(() => t.db.events(task.id).length > 0, "user event");
    const sessionId = t.db.task(task.id)!.session_id;
    t.fake.sessions.get(sessionId)!.listeners.clear(); // the old process's stream is gone
    t.fake.seed(sessionId, [
      { id: "", type: "session.status_running" },
      { id: "", type: "agent.message", content: [{ type: "text", text: "Finished while you were away" }] },
      { id: "", type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ]);
    const restarted = new TaskService(t.fake.asClient(), t.db, config);
    restarted.resumeUnsettled();
    await t.waitFor(() => t.db.task(task.id)!.status === "idle", "resumed task to settle");
    const texts = t.db.events(task.id).filter((e) => e.kind === "message");
    assert.equal(texts.length, 1, "events are not recorded twice");
  });
});

describe("billing and account", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  before(async () => (t = await setup()));
  after(() => t.app.close());

  async function webhook(event: object, secret = WEBHOOK_SECRET) {
    const payload = JSON.stringify(event);
    const signature = t.stripe.webhooks.generateTestHeaderString({ payload, secret });
    return t.app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
  }

  test("Stripe webhooks move a user between plans; forged ones are rejected", async () => {
    const token = await t.signUp("pay@example.com");
    const userId = t.db.userByEmail("pay@example.com")!.id;
    const forged = await webhook({ id: "evt_0", type: "checkout.session.completed", data: { object: {} } }, "whsec_wrong");
    assert.equal(forged.statusCode, 400);

    const completed = await webhook({
      id: "evt_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { object: "checkout.session", client_reference_id: userId, customer: "cus_1" } },
    });
    assert.equal(completed.statusCode, 200);
    let account = (await t.call("GET", "/v1/account", token)).json;
    assert.equal(account.plan, "pro");
    assert.equal(account.limitCents, 2500);

    await webhook({
      id: "evt_2",
      object: "event",
      type: "customer.subscription.deleted",
      data: { object: { object: "subscription", customer: "cus_1", status: "canceled" } },
    });
    account = (await t.call("GET", "/v1/account", token)).json;
    assert.equal(account.plan, "free");
  });

  test("deleting the account removes the twin, sessions and user", async () => {
    const token = await t.withTwin("bye@example.com");
    const task = (await t.call("POST", "/v1/tasks", token, { prompt: "Something" })).json.task as TaskSummary;
    await t.waitFor(async () => (await t.taskStatus(token, task.id)) === "idle");
    const user = t.db.userByEmail("bye@example.com")!;
    const sessionId = t.db.task(task.id)!.session_id;

    assert.equal((await t.call("DELETE", "/v1/account", token)).status, 204);
    assert.equal(t.fake.stores.has(user.memory_store_id!), false);
    assert.equal(t.fake.sessions.get(sessionId)!.deleted, true);
    assert.equal(t.db.userByEmail("bye@example.com"), undefined);
    assert.equal(t.db.task(task.id), undefined);
    assert.equal((await t.call("GET", "/v1/account", token)).status, 401);
  });

  test("legal pages are served", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const res = await t.app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /California|Acceptable use/);
    }
  });
});
