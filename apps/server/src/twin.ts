import type Anthropic from "@anthropic-ai/sdk";
import type { TwinProfile, WritingSample } from "@twinly/shared";
import type { Db } from "./db";

// The user's twin is a memory store: profile.md, writing-samples/*.md, and
// learned/preferences.md that the agent appends to as the user corrects it.

const PROFILE_PATH = "/profile.md";
const SAMPLES_PREFIX = "/writing-samples/";

// One Twin per request, bound to the signed-in user.
export class Twin {
  constructor(
    private readonly client: Anthropic,
    private readonly db: Db,
    private readonly userId: string,
  ) {}

  get storeId(): string | null {
    return this.db.userById(this.userId)?.memory_store_id ?? null;
  }

  async getProfile(): Promise<TwinProfile | null> {
    const memory = await this.findMemory(PROFILE_PATH);
    if (!memory || !this.storeId) return null;
    const full = await this.client.beta.memoryStores.memories.retrieve(memory.id, {
      memory_store_id: this.storeId,
    });
    return parseProfile(full.content ?? "");
  }

  async saveProfile(profile: TwinProfile) {
    const storeId = await this.ensureStore();
    await this.upsert(storeId, PROFILE_PATH, renderProfile(profile));
  }

  async listSamples(): Promise<WritingSample[]> {
    if (!this.storeId) return [];
    const samples: WritingSample[] = [];
    for await (const item of this.client.beta.memoryStores.memories.list(this.storeId, {
      path_prefix: SAMPLES_PREFIX,
    })) {
      if (item.type === "memory") {
        samples.push({ path: item.path, title: item.path.slice(SAMPLES_PREFIX.length).replace(/\.md$/, "") });
      }
    }
    return samples;
  }

  async addSample(title: string, text: string) {
    const storeId = await this.ensureStore();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sample";
    await this.upsert(storeId, `${SAMPLES_PREFIX}${slug}.md`, `# ${title}\n\n${text}\n`);
  }

  private async ensureStore(): Promise<string> {
    if (this.storeId) return this.storeId;
    const store = await this.client.beta.memoryStores.create({
      name: "twin",
      description:
        "The user's digital twin: profile.md (who they are and how they work), writing-samples/ (real text they wrote), learned/preferences.md (corrections they gave).",
    });
    this.db.updateUser(this.userId, { memory_store_id: store.id });
    return store.id;
  }

  /** Permanently deletes the twin (CCPA / account deletion). */
  async destroy() {
    const storeId = this.storeId;
    if (!storeId) return;
    await this.client.beta.memoryStores.delete(storeId);
    this.db.updateUser(this.userId, { memory_store_id: null });
  }

  private async findMemory(path: string) {
    if (!this.storeId) return null;
    for await (const item of this.client.beta.memoryStores.memories.list(this.storeId, { path_prefix: path })) {
      if (item.type === "memory" && item.path === path) return item;
    }
    return null;
  }

  private async upsert(storeId: string, path: string, content: string) {
    const existing = await this.findMemory(path);
    if (existing) {
      await this.client.beta.memoryStores.memories.update(existing.id, { memory_store_id: storeId, content });
    } else {
      await this.client.beta.memoryStores.memories.create(storeId, { path, content });
    }
  }
}

const PROFILE_FIELDS: [keyof TwinProfile, string][] = [
  ["name", "Name"],
  ["role", "Role"],
  ["company", "Company"],
  ["voice", "How I write"],
  ["preferences", "How I like work done"],
];

function renderProfile(profile: TwinProfile): string {
  return ["# Profile", ...PROFILE_FIELDS.map(([key, label]) => `\n## ${label}\n${profile[key].trim()}`)].join("\n") + "\n";
}

function parseProfile(markdown: string): TwinProfile {
  const profile: TwinProfile = { name: "", role: "", company: "", voice: "", preferences: "" };
  for (const section of markdown.split(/^## /m).slice(1)) {
    const newline = section.indexOf("\n");
    const label = newline === -1 ? section : section.slice(0, newline);
    const field = PROFILE_FIELDS.find(([, l]) => l === label.trim());
    if (field) profile[field[0]] = newline === -1 ? "" : section.slice(newline + 1).trim();
  }
  return profile;
}
