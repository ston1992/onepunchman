import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AuthResponse, TaskEvent } from "@twinly/shared";
import { emailToken, hashPassword, hashToken, verifyPassword, type Tokens } from "./auth";
import type { Billing } from "./billing";
import type { Db, TaskRow, TokenPurpose, UserRow } from "./db";
import { legalPage, messagePage, resetPage } from "./legal";
import { emails, type Mailer } from "./mail";
import { QuotaError, summarize, type TaskService } from "./tasks";
import { Twin } from "./twin";
import { accountView } from "./usage";

export interface AppDeps {
  db: Db;
  anthropic: Anthropic;
  tokens: Tokens;
  tasks: TaskService;
  billing?: Billing;
  /** Without a mailer, new accounts are verified on sign-up (dev mode). */
  mailer?: Mailer;
  publicUrl?: string;
  logger?: boolean;
}

const HOUR = 60 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow;
  }
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
});
const profileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().max(200),
  company: z.string().max(500),
  voice: z.string().max(4000),
  preferences: z.string().max(4000),
});
const sampleSchema = z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(50_000) });
const promptSchema = z.object({ prompt: z.string().trim().min(1).max(20_000) });
const messageSchema = z.object({ text: z.string().trim().min(1).max(20_000) });
const approvalSchema = z.object({ toolUseId: z.string().min(1), allow: z.boolean() });

export async function buildApp(deps: AppDeps) {
  const { db, anthropic, tokens, tasks, billing, mailer } = deps;
  const publicUrl = deps.publicUrl ?? "http://localhost:8787";
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1_000_000 });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "Invalid request" });
    if (err instanceof QuotaError) return reply.code(402).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong." : (err as Error).message });
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const claims = header.startsWith("Bearer ") ? await tokens.verify(header.slice(7)) : null;
    const user = claims ? db.userById(claims.userId) : undefined;
    if (!user || !tokens.current(claims!.version, user.password_hash)) {
      return reply.code(401).send({ error: "Please sign in again." });
    }
    req.user = user;
  };

  /** Emails a single-use link. Send failures are logged, not shown: they must not leak whether an email exists. */
  const sendLink = async (user: UserRow, purpose: TokenPurpose, path: string, ttlMs: number) => {
    if (!mailer) return;
    const { token, hash } = emailToken();
    db.saveToken(hash, user.id, purpose, new Date(Date.now() + ttlMs).toISOString());
    const link = `${publicUrl}${path}?token=${token}`;
    const email = purpose === "verify_email" ? emails.verify(link) : emails.reset(link);
    await mailer.send(user.email, email.subject, email.html).catch((err: unknown) => app.log.error(err, "email failed"));
  };

  const requireVerified = (user: UserRow) => {
    if (!user.email_verified) {
      throw Object.assign(new Error("Confirm your email first: we sent you a link."), { statusCode: 403 });
    }
  };

  /** Loads a task and makes sure it belongs to the signed-in user. */
  const ownTask = (req: FastifyRequest<{ Params: { id: string } }>): TaskRow => {
    const task = db.task(req.params.id);
    if (!task || task.user_id !== req.user.id) throw Object.assign(new Error("Task not found"), { statusCode: 404 });
    return task;
  };

  const authReply = async (user: UserRow): Promise<AuthResponse> => ({
    token: await tokens.issue(user.id, user.password_hash),
    account: accountView(db, user, Boolean(billing)),
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/privacy", async (_req, reply) => reply.type("text/html").send(legalPage("privacy")));
  app.get("/terms", async (_req, reply) => reply.type("text/html").send(legalPage("terms")));
  app.get("/billing/done", async (_req, reply) => reply.type("text/html").send(legalPage("billing-done")));

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/v1/auth/signup", authLimit, async (req, reply) => {
    const { email, password } = credentials.parse(req.body);
    if (db.userByEmail(email)) return reply.code(409).send({ error: "An account with this email already exists." });
    const user = db.createUser({
      id: randomUUID(),
      email,
      password_hash: await hashPassword(password),
      email_verified: mailer ? 0 : 1,
    });
    await sendLink(user, "verify_email", "/verify", 7 * 24 * HOUR);
    return reply.code(201).send(await authReply(user));
  });

  app.post("/v1/auth/forgot", authLimit, async (req, reply) => {
    const { email } = credentials.pick({ email: true }).parse(req.body);
    const user = db.userByEmail(email);
    if (user) await sendLink(user, "reset_password", "/reset", HOUR);
    return reply.code(202).send(); // same answer either way: don't reveal who has an account
  });

  app.post("/v1/auth/reset", authLimit, async (req, reply) => {
    const { token, password } = z.object({ token: z.string().min(1).max(200), password: credentials.shape.password }).parse(req.body);
    const userId = db.consumeToken(hashToken(token), "reset_password");
    if (!userId) return reply.code(400).send({ error: "This link has expired. Request a new one from the app." });
    // Resetting via an emailed link also proves the address.
    db.updateUser(userId, { password_hash: await hashPassword(password), email_verified: 1 });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { token?: string } }>("/reset", async (req, reply) =>
    reply.type("text/html").send(resetPage(req.query.token ?? "")),
  );

  app.get<{ Querystring: { token?: string } }>("/verify", async (req, reply) => {
    const userId = db.consumeToken(hashToken(req.query.token ?? ""), "verify_email");
    if (userId) db.updateUser(userId, { email_verified: 1 });
    return reply
      .type("text/html")
      .send(
        userId
          ? messagePage("Email confirmed", "You're all set. Go back to Twinly and give your twin its first task.")
          : messagePage("Link expired", "This link has expired or was already used. You can request a new one from the app."),
      );
  });

  app.post("/v1/auth/login", authLimit, async (req, reply) => {
    const { email, password } = credentials.extend({ password: z.string().min(1).max(200) }).parse(req.body);
    const user = db.userByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: "Wrong email or password." });
    }
    return authReply(user);
  });

  app.register(async (api) => {
    api.addHook("preHandler", authenticate);

    api.get("/v1/account", async (req) => accountView(db, req.user, Boolean(billing)));

    api.post("/v1/account/verification", { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } }, async (req, reply) => {
      if (!req.user.email_verified) await sendLink(req.user, "verify_email", "/verify", 7 * 24 * HOUR);
      return reply.code(202).send();
    });

    api.delete("/v1/account", async (req, reply) => {
      await billing?.cancelAll(req.user);
      await tasks.destroyAll(req.user.id);
      await new Twin(anthropic, db, req.user.id).destroy();
      db.deleteUser(req.user.id);
      return reply.code(204).send();
    });

    api.post("/v1/billing/checkout", async (req, reply) => {
      if (!billing) return reply.code(404).send({ error: "Billing is not enabled." });
      return { url: await billing.checkoutUrl(req.user) };
    });

    api.post("/v1/billing/portal", async (req, reply) => {
      const url = await billing?.portalUrl(req.user);
      if (!url) return reply.code(404).send({ error: "No subscription to manage." });
      return { url };
    });

    api.get("/v1/twin/profile", async (req) => ({ profile: await new Twin(anthropic, db, req.user.id).getProfile() }));
    api.put("/v1/twin/profile", async (req, reply) => {
      await new Twin(anthropic, db, req.user.id).saveProfile(profileSchema.parse(req.body));
      return reply.code(204).send();
    });
    api.get("/v1/twin/samples", async (req) => ({ samples: await new Twin(anthropic, db, req.user.id).listSamples() }));
    api.post("/v1/twin/samples", async (req, reply) => {
      const { title, text } = sampleSchema.parse(req.body);
      await new Twin(anthropic, db, req.user.id).addSample(title, text);
      return reply.code(204).send();
    });

    api.get("/v1/tasks", async (req) => ({ tasks: db.tasksForUser(req.user.id).map(summarize) }));
    api.post("/v1/tasks", async (req, reply) => {
      requireVerified(req.user);
      const { prompt } = promptSchema.parse(req.body);
      return reply.code(201).send({ task: await tasks.start(req.user, prompt) });
    });
    api.get<{ Params: { id: string } }>("/v1/tasks/:id/events", async (req) => ({ events: db.events(ownTask(req).id) }));
    api.post<{ Params: { id: string } }>("/v1/tasks/:id/messages", async (req, reply) => {
      const task = ownTask(req);
      await tasks.followUp(req.user, task, messageSchema.parse(req.body).text);
      return reply.code(202).send();
    });
    api.post<{ Params: { id: string } }>("/v1/tasks/:id/approvals", async (req, reply) => {
      const { toolUseId, allow } = approvalSchema.parse(req.body);
      await tasks.answerApproval(ownTask(req), toolUseId, allow);
      return reply.code(202).send();
    });
    api.post<{ Params: { id: string } }>("/v1/tasks/:id/stop", async (req, reply) => {
      await tasks.stop(ownTask(req));
      return reply.code(202).send();
    });
    api.get<{ Params: { id: string } }>("/v1/tasks/:id/files", async (req) => ({ files: await tasks.files(ownTask(req)) }));
    api.get<{ Params: { id: string; fileId: string } }>("/v1/tasks/:id/files/:fileId", async (req, reply) => {
      const file = await tasks.download(ownTask(req), req.params.fileId);
      if (!file) return reply.code(404).send({ error: "File not found" });
      reply.header("content-type", "application/octet-stream");
      reply.header("content-disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
      return reply.send(Buffer.from(await file.body.arrayBuffer()));
    });

    // Server-sent events: every status change and timeline event of one task.
    api.get<{ Params: { id: string } }>("/v1/tasks/:id/stream", async (req, reply) => {
      const task = ownTask(req);
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const write = (event: TaskEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      write({ taskId: task.id, kind: "status", status: db.task(task.id)!.status });
      const unsubscribe = tasks.subscribe(task.id, write);
      const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  });

  // Stripe needs the raw body to verify the signature.
  app.register(async (hooks) => {
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    hooks.post("/v1/billing/webhook", async (req, reply) => {
      if (!billing) return reply.code(404).send();
      try {
        await billing.handleWebhook(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""));
      } catch (err) {
        app.log.warn(err, "Rejected Stripe webhook");
        return reply.code(400).send({ error: "Invalid signature" });
      }
      return { received: true };
    });
  });

  return app;
}
