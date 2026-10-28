// Checks the plugin link and the plugin install.
// The link forms go through the real deep link parser of the main process. The install, the
// uninstall and the refusal of an unknown slug go through the real skill service and the real MCP
// server store of the host, with the listing read from a local catalog file. The order the window
// installs in is the one of `installPlugin` in
// `src/renderer/src/features/settings/marketplace-controller.ts`; the renderer is not a part of the
// node project, so this check drives the two services itself.
// Run: bun scripts/plugin-install-e2e.ts
// Writes .openbot-build/plugin-install-e2e/report.json.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInviteUrl } from "@openbot/contracts/invite-links";
import type { InstalledSkill, MarketplaceSkillDetail, SkillCategory } from "@openbot/contracts/ipc";
import { isSkillCategory } from "@openbot/contracts/ipc";
import { createOpenBotPluginUrl, createPluginShareUrl } from "@openbot/contracts/plugin-links";
import {
  isPluginAppConfig,
  type MarketplacePluginApp,
  type MarketplacePluginDetail,
  type MarketplacePluginPrompt,
  type MarketplacePluginSkill,
} from "@openbot/ui/features/settings/marketplace-plugins";
import { Effect, Exit, Schema } from "effect";
import { zipSync } from "fflate";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import {
  databaseRow,
  databaseRows,
  requiredNumberColumn,
  requiredStringColumn,
} from "../src/backend/database/database-rows";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { CentralAuthOperationError } from "../src/main/central-auth-effects";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { parseDeepLink } from "../src/main/deep-link-router";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";
import { createPluginAppConfig } from "../src/renderer/src/features/settings/marketplace-plugin-catalog";

const OUT = resolve(import.meta.dirname, "../.openbot-build/plugin-install-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; unverified: string[]; steps: Step[] } = {
  passed: false,
  unverified: [
    "The Marketplace page and the page that names a slug the catalog does not hold. This check drives the services behind the install; it does not render a page.",
    "The order the window installs in and the order it uninstalls in. That order lives in the renderer, which the node project does not typecheck, so this check drives the two services itself.",
  ],
  steps: [],
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const unused = () => Effect.die(new Error("Not used by this check."));
const agentBrowser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/*
 * The catalog this check installs from, in the shape of `marketplace/plugin-catalog/`: an index and
 * one listing per plugin, the listing in the shape of
 * `marketplace/plugin-catalog/plugins/<slug>/plugin.json`. The build script refuses a plugin that
 * lists skills until pinned versions exist, so the file here is written by this script and read
 * back: the catalog the install reads is a file on this computer.
 */
interface CatalogListing {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: SkillCategory;
  creatorName: string;
  iconUrl: string | null;
  version: string;
  prompts: MarketplacePluginPrompt[];
  apps: MarketplacePluginApp[];
  skills: MarketplacePluginSkill[];
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
}

const catalogListing: CatalogListing = {
  slug: "checkline",
  name: "Checkline",
  tagline: "The open checks of a project",
  description: "Checkline lists the open checks of a project and writes their state.",
  category: "productivity",
  creatorName: "Checkline",
  iconUrl: null,
  version: "1.0.0",
  prompts: [{ id: "prompt-open-checks", text: "Which checks are open?" }],
  apps: [
    {
      id: "app-checkline-mcp",
      name: "checkline",
      description: "The Checkline MCP server.",
      iconUrl: null,
      server: { name: "checkline", transport: "http", url: "https://mcp.checkline.invalid/mcp" },
    },
  ],
  skills: [
    {
      id: "checkline-triage",
      versionId: "checkline-triage-1",
      slug: "checkline-triage",
      description: "Triage the open checks of a project.",
    },
  ],
  websiteUrl: null,
  privacyPolicyUrl: null,
  termsUrl: null,
};
const catalog = {
  schemaVersion: 1,
  catalogVersion: "v1",
  updatedAt: "2026-10-28T00:00:00.000Z",
  plugins: [catalogListing],
};
const listingSlug = catalogListing.slug;
const skillPin = catalogListing.skills[0];
assert.ok(skillPin, "The catalog listing holds no skill.");

/* The skill bundle the account service would serve for the pinned version. The name in the front
   matter gives the slug the install writes, so the two agree. */
const skillFiles = {
  "SKILL.md": Buffer.from(
    "---\nname: Checkline Triage\ndescription: Triage the open checks of a project.\n---\nRead the open checks and write their state.\n",
  ),
};
const skillBundle = zipSync(skillFiles);
const skillDetail: MarketplaceSkillDetail = {
  id: skillPin.id,
  versionId: skillPin.versionId,
  slug: skillPin.slug,
  name: "Checkline Triage",
  description: skillPin.description,
  category: "productivity",
  creatorName: "Checkline",
  creatorAvatarUrl: null,
  version: 1,
  installs: 0,
  featured: false,
  iconUrl: null,
  updatedAt: "2026-10-28T00:00:00.000Z",
  instructions: "Read the open checks and write their state.",
  files: Object.keys(skillFiles),
  bundleSha256: hash(skillBundle),
};

const decodeLock = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      skills: Schema.Record(
        Schema.String,
        Schema.Struct({
          skillId: Schema.String,
          versionId: Schema.String,
          slug: Schema.String,
          version: Schema.Number,
          bundleSha256: Schema.String,
        }),
      ),
    }),
  ),
);

/* The catalog file, as it is read back. The listing is decoded from the file, not from the value
   the script holds, so a file that does not hold the listing fails the check. */
interface DecodedApp {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  server: { name: string; transport: string; url: string };
}

const decodeCatalogFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Number,
      catalogVersion: Schema.String,
      updatedAt: Schema.String,
      plugins: Schema.Array(
        Schema.Struct({
          slug: Schema.String,
          name: Schema.String,
          tagline: Schema.String,
          description: Schema.String,
          category: Schema.String,
          creatorName: Schema.String,
          iconUrl: Schema.NullOr(Schema.String),
          version: Schema.String,
          prompts: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
          apps: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              description: Schema.String,
              iconUrl: Schema.NullOr(Schema.String),
              server: Schema.Struct({ name: Schema.String, transport: Schema.String, url: Schema.String }),
            }),
          ),
          skills: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              versionId: Schema.String,
              slug: Schema.String,
              description: Schema.String,
            }),
          ),
          websiteUrl: Schema.NullOr(Schema.String),
          privacyPolicyUrl: Schema.NullOr(Schema.String),
          termsUrl: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
);

/** The app of the listing, as the marketplace reads it. */
function toPluginApp(app: DecodedApp): MarketplacePluginApp {
  if (app.server.transport !== "http") throw new Error("The catalog app is not an http server.");
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    iconUrl: app.iconUrl,
    server: { name: app.server.name, transport: "http", url: app.server.url },
  };
}

const root = await mkdtemp(join(tmpdir(), "openbot-plugin-install-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const catalogPath = join(OUT, "catalog.json");
const bundlePath = join(OUT, "checkline-triage.zip");

/* The account service, with the catalog file as its answer. Only the skill of the catalog is
   served; every other path fails as the service fails for a skill it does not hold. */
class CatalogAuth extends CentralAuthManager {
  override requestAuthorized<T>(
    path: string,
    init: RequestInit,
    decode: (value: unknown) => T,
  ): Effect.Effect<T, CentralAuthOperationError> {
    return Effect.gen(function* () {
      if (init.method === "GET") {
        if (path === `/v1/skills/${skillDetail.id}`) return decode(skillDetail);
        if (path === `/v1/skills/${skillDetail.id}/versions/${skillDetail.versionId}`) return decode(skillDetail);
        return yield* Effect.fail(new CentralAuthOperationError({ cause: `The catalog holds no skill at ${path}.` }));
      }
      if (init.method === "POST" && path === `/v1/skills/${skillDetail.id}/install`) return decode({ installed: true });
      return yield* Effect.fail(new CentralAuthOperationError({ cause: `The catalog holds no skill at ${path}.` }));
    });
  }

  override readonly downloadAuthorized = (path: string): Effect.Effect<Uint8Array, CentralAuthOperationError> =>
    Effect.gen(function* () {
      if (path !== `/v1/skills/${skillDetail.id}/versions/${skillDetail.versionId}/content`)
        return yield* Effect.fail(new CentralAuthOperationError({ cause: `The catalog holds no bundle at ${path}.` }));
      return yield* Effect.promise(async () => new Uint8Array(await readFile(bundlePath)));
    });
}

const database = new OpenBotDatabase(userData);
const agentStore = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, agentStore.sharedRoot, agentStore.database);
const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
const agents = new AgentService({ store: agentStore, mailbox, browser: agentBrowser, sidebarLayout: sidebar });

try {
  await mkdir(OUT, { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(bundlePath, skillBundle);

  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(agentStore.initialize());
  await runCauseEffect(mailbox.initialize());

  /* Two agents. The plugin's skills go to the one whose chat is open, so the check watches which
     agent holds the skill and which holds nothing. */
  const first = await runCauseEffect(
    agents.createAgentProfile({ name: "First Agent", description: "", avatarSeed: "first", avatarHue: null }),
  );
  const second = await runCauseEffect(
    agents.createAgentProfile({ name: "Second Agent", description: "", avatarSeed: "second", avatarHue: null }),
  );

  const refreshes: string[] = [];
  const auth = new CatalogAuth({
    apiUrl: "https://example.invalid",
    storagePath: join(root, "auth.json"),
    canPersist: () => false,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
  const skills = new SkillMarketplaceService(
    auth,
    () => agents.listAgents(),
    (agentId) =>
      Effect.sync(() => {
        refreshes.push(agentId);
      }),
  );

  /* The catalog file, read back, as the listing the install uses. */
  const readCatalog = decodeCatalogFile(await readFile(catalogPath, "utf8"));
  const plugin = readCatalog.plugins.find((candidate) => candidate.slug === listingSlug);
  assert.ok(plugin, "The catalog file holds no listing for the slug.");
  if (!isSkillCategory(plugin.category))
    throw new Error(`The catalog listing names an unknown category: ${plugin.category}.`);
  const listing: MarketplacePluginDetail = {
    id: `plugin-${plugin.slug}`,
    slug: plugin.slug,
    name: plugin.name,
    tagline: plugin.tagline,
    description: plugin.description,
    category: plugin.category,
    creatorName: plugin.creatorName,
    creatorAvatarUrl: null,
    iconUrl: plugin.iconUrl,
    version: plugin.version,
    installs: 0,
    featured: false,
    updatedAt: readCatalog.updatedAt,
    shareUrl: createPluginShareUrl(plugin.slug),
    prompts: [...plugin.prompts],
    apps: plugin.apps.map(toPluginApp),
    skills: [...plugin.skills],
    websiteUrl: plugin.websiteUrl,
    privacyPolicyUrl: plugin.privacyPolicyUrl,
    termsUrl: plugin.termsUrl,
  };
  const app = listing.apps[0];
  assert.ok(app, "The catalog file holds no app.");

  await step("the link forms", async () => {
    const invite = createInviteUrl({
      apiUrl: "https://api.openbot.run",
      serverId: "11111111-2222-4333-8444-555555555555",
      fingerprint: "a".repeat(43),
      token: "b".repeat(43),
    });
    /* The URL parser normalizes a path that climbs out, so `openbot://plugins/../join` holds one
       segment and names a plugin slug. It never names an invitation: the invitation parser asks
       for the host `join`, and the same link with the fields of an invitation is refused because a
       plugin link carries no query. */
    const forms: { name: string; link: string; kind: string | null; slug?: string }[] = [
      { name: "the app link", link: createOpenBotPluginUrl(listing.slug), kind: "plugin", slug: listing.slug },
      { name: "the shared link", link: createPluginShareUrl(listing.slug), kind: "plugin", slug: listing.slug },
      { name: "a path that climbs out", link: "openbot://plugins/../join", kind: "plugin", slug: "join" },
      {
        name: "a path that climbs out with the fields of an invitation",
        link: `openbot://plugins/../join?${new URL(invite).search}`,
        kind: null,
      },
      { name: "a query", link: `openbot://plugins/${listing.slug}?install=1`, kind: null },
      { name: "a hash", link: `openbot://plugins/${listing.slug}#top`, kind: null },
      { name: "a second segment", link: `openbot://plugins/${listing.slug}/extra`, kind: null },
      { name: "a trailing slash", link: `openbot://plugins/${listing.slug}/`, kind: null },
      { name: "a slug with a dot", link: "openbot://plugins/catalog.json", kind: null },
      { name: "an empty slug", link: "openbot://plugins/", kind: null },
      {
        name: "a host that looks like ours",
        link: `https://openbot.run.example.com/plugins/${listing.slug}`,
        kind: null,
      },
      { name: "an invitation", link: invite, kind: "invite" },
      { name: "something that is not a link", link: "not a link", kind: null },
    ];
    const answers: string[] = [];
    for (const form of forms) {
      const link = parseDeepLink(form.link);
      assert.equal(link?.kind ?? null, form.kind, `The link form "${form.name}" is ${form.kind}.`);
      if (form.slug) assert.equal(link?.kind === "plugin" ? link.slug : null, form.slug, `The slug of "${form.name}".`);
      answers.push(`${form.name}: ${link?.kind ?? "no link"}`);
    }
    /* A link names a listing. It never installs one. */
    assert.deepEqual(agents.listMcpServers(), [], "A link saved an MCP server.");
    assert.deepEqual(refreshes, [], "A link installed a skill.");
    return answers;
  });

  /* The install of the window: the skills go first, so a failure never leaves a server standing
     that nothing knows how to drive. */
  await step("the pinned skill goes to the chosen agent", async () => {
    const installed = await Effect.runPromise(
      skills.install({ agentId: second.id, skillId: skillDetail.id, versionId: skillDetail.versionId }),
    );
    assert.equal(installed.skillId, skillDetail.id);
    assert.equal(installed.state, "installed");
    const lock = decodeLock(await readFile(join(second.workspacePath, ".openbot/skills-lock.json"), "utf8"));
    const entry = lock.skills[skillDetail.id];
    assert.ok(entry, "The chosen agent holds no skill.");
    assert.equal(entry.versionId, skillDetail.versionId, "The skill is not the pinned version.");
    assert.equal(entry.bundleSha256, skillDetail.bundleSha256);
    await assert.rejects(readFile(join(first.workspacePath, ".openbot/skills-lock.json"), "utf8"));
    assert.deepEqual(refreshes, [second.id], "The runtime of another agent was refreshed.");
    const listed: InstalledSkill[] = await Effect.runPromise(skills.listInstalled(second.id));
    assert.deepEqual(
      listed.map((skill) => skill.skillId),
      [skillDetail.id],
    );
    return { agent: second.name, versionId: entry.versionId };
  });

  /* Then the app, as an MCP server of the host. */
  await step("the app is saved as a host-global MCP server", async () => {
    const config = createPluginAppConfig(app);
    const saved = await Effect.runPromise(agents.saveMcpServer({ config }));
    assert.equal(saved.length, 1, "The host does not hold exactly one MCP server.");
    const row = saved[0];
    assert.ok(row, "The host holds no MCP server.");
    assert.equal(row.name, app.server.name);
    assert.equal(app.server.transport, "http", "The catalog app is not an http server.");
    assert.equal(row.url, app.server.transport === "http" ? app.server.url : "");
    assert.ok(isPluginAppConfig(row, app), "The row is not the row of this app.");
    /* The row is the host's: the table holds no agent, so every agent of this computer uses it. */
    const count = databaseRow(
      database.connection.prepare("SELECT COUNT(*) AS total FROM projection_mcp_servers").get(),
    );
    assert.ok(count, "The host holds no MCP server table.");
    assert.equal(requiredNumberColumn(count, "total"), 1);
    const columns = databaseRows(database.connection.prepare("PRAGMA table_info(projection_mcp_servers)").all());
    assert.ok(
      columns.every((column) => !requiredStringColumn(column, "name").includes("agent")),
      "The MCP server table names an agent, so the row is not host-global.",
    );
    return { name: row.name, url: row.url };
  });

  /* The uninstall of the window: the app goes first and the skill after. */
  await step("the uninstall takes the app and the skill away", async () => {
    const row = agents.listMcpServers()[0];
    assert.ok(row, "The host holds no MCP server to remove.");
    const left = await Effect.runPromise(agents.removeMcpServer({ mcpServerId: row.id }));
    assert.deepEqual(left, [], "The host still holds the MCP server.");
    await Effect.runPromise(skills.uninstall({ agentId: second.id, skillId: skillDetail.id }));
    const lock = decodeLock(await readFile(join(second.workspacePath, ".openbot/skills-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.skills), [], "The agent still holds the skill.");
    const listed = await Effect.runPromise(skills.listInstalled(second.id));
    assert.deepEqual(listed, [], "The agent still lists the skill.");
    return { servers: left.length, skills: listed.length };
  });

  await step("a slug the catalog does not hold is refused", async () => {
    const unknown = "not-in-the-catalog";
    const link = parseDeepLink(`openbot://plugins/${unknown}`);
    assert.equal(link?.kind, "plugin", "The link is not a plugin link.");
    assert.equal(link?.kind === "plugin" ? link.slug : null, unknown);
    assert.ok(
      !readCatalog.plugins.some((candidate) => candidate.slug === unknown),
      "The catalog holds the slug after all.",
    );
    /* The skill of a slug the catalog does not hold is not served, so the install fails and writes
       nothing. The host keeps no server for it either. */
    const result = await Effect.runPromiseExit(
      skills.install({ agentId: second.id, skillId: `${unknown}-skill`, versionId: `${unknown}-version` }),
    );
    assert.ok(Exit.isFailure(result), "The install of an unknown skill succeeded.");
    assert.deepEqual(agents.listMcpServers(), [], "The host holds an MCP server for an unknown slug.");
    const lock = decodeLock(await readFile(join(second.workspacePath, ".openbot/skills-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.skills), [], "The agent holds a skill for an unknown slug.");
    return { slug: unknown, refused: true };
  });

  report.passed = true;
} finally {
  await runCauseEffect(agents.stop()).catch(() => undefined);
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
}
