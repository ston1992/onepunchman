// One-time setup: creates (or updates) the cloud environment and the twin agent,
// then writes their IDs into .env. Run again after editing agent-definition.ts.
//
//   npm run setup:cloud            # web tools off, sandbox egress limited to package managers
//   npm run setup:cloud -- --web   # web tools on, sandbox gets unrestricted egress

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { twinAgentParams } from "../src/main/core/agent-definition";

const ENV_FILE = ".env";
const enableWeb = process.argv.includes("--web");
const client = new Anthropic();

function writeEnv(values: Record<string, string>) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : readFileSync(".env.example", "utf8");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, "m").test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
      : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(ENV_FILE, text);
}

async function main() {
  const networking = enableWeb
    ? ({ type: "unrestricted" } as const)
    : ({ type: "limited", allow_package_managers: true, allow_mcp_servers: false } as const);

  let environmentId = process.env.TWIN_ENVIRONMENT_ID;
  if (environmentId) {
    await client.beta.environments.update(environmentId, { config: { type: "cloud", networking } });
    console.log(`Updated environment ${environmentId}`);
  } else {
    const environment = await client.beta.environments.create({
      name: "twinly-cloud",
      config: { type: "cloud", networking },
    });
    environmentId = environment.id;
    console.log(`Created environment ${environmentId}`);
  }

  const params = twinAgentParams({ enableWeb });
  let agentId = process.env.TWIN_AGENT_ID;
  if (agentId) {
    const current = await client.beta.agents.retrieve(agentId);
    const updated = await client.beta.agents.update(agentId, { ...params, version: current.version });
    console.log(`Updated agent ${agentId} to version ${updated.version}`);
  } else {
    const agent = await client.beta.agents.create(params);
    agentId = agent.id;
    console.log(`Created agent ${agentId} (version ${agent.version})`);
  }

  writeEnv({ TWIN_ENVIRONMENT_ID: environmentId, TWIN_AGENT_ID: agentId });
  console.log(`Saved IDs to ${ENV_FILE}. Web tools: ${enableWeb ? "on" : "off"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
