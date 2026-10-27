// Runs the real server against an in-memory fake of the Anthropic API, for UI
// work and end-to-end tests without an API key or spend.
//
//   npm run dev:fake -w @twinly/server      # listens on :8787

import { buildApp } from "../src/app";
import { Tokens } from "../src/auth";
import { Db } from "../src/db";
import { TaskService } from "../src/tasks";
import { FakeAnthropic } from "../test/fake-anthropic";

const fake = new FakeAnthropic();
fake.stepDelayMs = 600;
const db = new Db(":memory:");
const tasks = new TaskService(fake.asClient(), db, { agentId: "agent_fake", environmentId: "env_fake", taskBudgetCents: 500 });
const app = await buildApp({ db, anthropic: fake.asClient(), tokens: new Tokens("fake-server-secret-".repeat(3)), tasks });
await app.listen({ port: Number(process.env.PORT || 8787), host: "127.0.0.1" });
console.log(`Fake Twinly server on http://127.0.0.1:${process.env.PORT || 8787}`);
