import Anthropic from "@anthropic-ai/sdk";
import cors from "@fastify/cors";
import { buildApp } from "./app";
import { Tokens } from "./auth";
import { Billing } from "./billing";
import { loadConfig } from "./config";
import { Db } from "./db";
import { ResendMailer } from "./mail";
import { TaskService } from "./tasks";

const config = loadConfig();
const db = new Db(config.databasePath);
const anthropic = new Anthropic();
const tasks = new TaskService(anthropic, db, config);
const billing = config.stripe ? new Billing({ ...config.stripe, publicUrl: config.publicUrl }, db) : undefined;

const mailer = config.resend ? new ResendMailer(config.resend.apiKey, config.resend.from) : undefined;

const app = await buildApp({
  db,
  anthropic,
  tokens: new Tokens(config.jwtSecret),
  tasks,
  billing,
  mailer,
  publicUrl: config.publicUrl,
  logger: true,
});
if (!mailer) app.log.warn("RESEND_API_KEY not set: emails are off and new accounts are auto-verified (dev mode)");
// The desktop app calls from its main process, so no browser origin needs access.
await app.register(cors, { origin: false });

tasks.resumeUnsettled();
await app.listen({ port: config.port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
