// Run: bun scripts/local-skill-library-e2e.ts
// Report: .openbot-build/local-skill-library-e2e/report.json
//
// An agent prepares a folder with a SKILL.md in its own workspace and asks for a local skill. The
// library publishes that folder as a revision, and the skill service installs a revision into the
// workspace of an agent. This check drives the real library and the real service on a temporary
// directory. It holds that a published revision stays readable after a newer one is published,
// that a revision that expects an old number is refused, that an install writes both provider
// folders of the agent, that an installed copy does not follow a new revision, and that a file the
// user changed is never overwritten.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import { CentralAuthOperationError } from "../src/main/central-auth-effects";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { LocalSkillLibrary } from "../src/main/local-skill-library";
import { SkillMarketplaceService } from "../src/main/skill-marketplace-service";

const run = Effect.runPromise;

/** The folders of the agent workspace that a provider reads a skill from. */
const PROVIDER_FOLDERS = [".agents/skills", ".claude/skills"] as const;
/** The folder of the workspace that holds the skill the agent prepared. */
const SOURCE_FOLDER = "skills/local-skill";
/** The slug of the skill: the name of its folder in the workspace and of the installed copy. */
const SLUG = "local-skill";
/** The text a user writes into an installed file. */
const USER_EDIT = "---\nname: local-skill\ndescription: A local skill the user changed.\n---\n\nMy own notes.\n";

function markdown(body: string): string {
  return `---\nname: ${SLUG}\ndescription: A local skill that the end-to-end check publishes and installs.\n---\n\n${body}\n`;
}

const FIRST = markdown("The first revision of the skill.");
const SECOND = markdown("The second revision of the skill.");
const THIRD = markdown("The third revision of the skill.");
const FIRST_NOTES = "Notes of the first revision.\n";
const SECOND_NOTES = "Notes of the second revision.\n";
const THIRD_NOTES = "Notes of the third revision.\n";

const decodeLock = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      skills: Schema.Record(
        Schema.String,
        Schema.Struct({
          skillId: Schema.String,
          slug: Schema.String,
          version: Schema.Number,
          files: Schema.Record(Schema.String, Schema.String),
        }),
      ),
    }),
  ),
);

/** The account service never serves a local skill, so every call to it must fail. */
class OfflineAuth extends CentralAuthManager {
  override requestAuthorized<T>(
    _path: string,
    _init: RequestInit,
    _decoder: (value: unknown) => T,
  ): Effect.Effect<T, CentralAuthOperationError> {
    return Effect.fail(new CentralAuthOperationError({ cause: "A local skill must not call the account service." }));
  }
  override readonly downloadAuthorized = (path: string): Effect.Effect<Uint8Array, CentralAuthOperationError> =>
    Effect.fail(new CentralAuthOperationError({ cause: `A local skill must not download ${path}.` }));
}

interface Fixture {
  root: string;
  workspace: string;
  agent: AgentSummary;
  library: LocalSkillLibrary;
  service: SkillMarketplaceService;
}

function agentSummary(id: string, workspacePath: string): AgentSummary {
  return {
    id,
    name: "Local Skill Agent",
    title: "",
    description: "",
    notifications: false,
    provider: "codex",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath,
    preview: "",
    updatedAt: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "local-skill-library-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, SOURCE_FOLDER, "references"), { recursive: true });
  const agent = agentSummary("local-skill-agent", workspace);
  const library = new LocalSkillLibrary(join(root, "library"), () => [agent]);
  const auth = new OfflineAuth({
    apiUrl: "https://example.invalid",
    storagePath: join(workspace, "auth.json"),
    canPersist: () => false,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString("utf8"),
  });
  const service = new SkillMarketplaceService(
    auth,
    () => [agent],
    () => Effect.void,
    library,
  );
  return { root, workspace, agent, library, service };
}

/** The skill the agent prepared in its workspace. */
async function writeSource(fixture: Fixture, body: string, notes: string): Promise<void> {
  const folder = join(fixture.workspace, SOURCE_FOLDER);
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), body);
  await writeFile(join(folder, "references", "notes.md"), notes);
}

/** The text of an error that the library or the service reports. */
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The text of the error that stopped a check. */
function failureText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** The installed copy of the skill, in both provider folders of the agent. */
async function assertInstalled(fixture: Fixture, body: string, notes: string): Promise<void> {
  for (const folder of PROVIDER_FOLDERS) {
    assert.equal(
      await readFile(join(fixture.workspace, folder, SLUG, "SKILL.md"), "utf8"),
      body,
      `The copy in ${folder} holds another text.`,
    );
    assert.equal(
      await readFile(join(fixture.workspace, folder, SLUG, "references", "notes.md"), "utf8"),
      notes,
      `The copy in ${folder} holds another notes file.`,
    );
  }
}

/** The record of the installed skills of the agent. */
async function lockEntry(fixture: Fixture, skillId: string) {
  const lock = decodeLock(await readFile(join(fixture.workspace, ".openbot", "skills-lock.json"), "utf8"));
  const entry = lock.skills[skillId];
  assert.ok(entry, "The lock file holds no record of the skill.");
  return entry;
}

/** The revisions the library published for the skill. */
async function publishedRevisions(fixture: Fixture, skillId: string): Promise<string[]> {
  return (await readdir(join(fixture.root, "library", skillId))).sort();
}

/** The skill of the library with its newest revision. */
async function newestSkill(fixture: Fixture) {
  const listed = await run(fixture.library.list());
  assert.equal(listed.length, 1, "The library holds another number of skills.");
  const skill = listed[0];
  assert.ok(skill, "The library holds no skill.");
  return skill;
}

/** The first check: a skill is published, and a new revision does not change the old one. */
async function checkCreateAndRevise(fixture: Fixture): Promise<void> {
  await writeSource(fixture, FIRST, FIRST_NOTES);
  const created = await run(fixture.library.create(fixture.agent.id, SOURCE_FOLDER));
  assert.match(created.id, /^local-skill-[\da-f-]{36}$/u, "The library gave the skill another id.");
  assert.equal(created.version, 1, "The library published another revision.");
  assert.equal(created.slug, SLUG, "The library published another slug.");
  assert.equal(created.instructions, "The first revision of the skill.", "The skill holds other text.");
  const firstBundle = await run(fixture.library.bundle(created.id, 1));

  await writeSource(fixture, SECOND, SECOND_NOTES);
  const revised = await run(fixture.library.revise(fixture.agent.id, created.id, 1, SOURCE_FOLDER));
  assert.equal(revised.id, created.id, "The revision published another skill.");
  assert.equal(revised.version, 2, "The library published another revision.");
  assert.equal(revised.instructions, "The second revision of the skill.", "The skill holds other text.");
  assert.notEqual(revised.bundleSha256, created.bundleSha256, "The revision kept the bundle of the first one.");

  // The first revision stays as it was published.
  const kept = await run(fixture.library.get(created.id, 1));
  assert.equal(kept.version, 1, "The library read another revision.");
  assert.equal(kept.instructions, "The first revision of the skill.", "The first revision holds other text.");
  assert.equal(kept.bundleSha256, created.bundleSha256, "The first revision holds another bundle.");
  assert.deepEqual(
    await run(fixture.library.bundle(created.id, 1)),
    firstBundle,
    "The bundle of the first revision changed.",
  );

  // The library lists the newest revision, and it holds both revisions.
  const newest = await newestSkill(fixture);
  assert.equal(newest.version, 2, "The library lists another revision.");
  assert.deepEqual(await publishedRevisions(fixture, created.id), ["1", "2"], "The library holds other revisions.");
}

/** The second check: a revision that expects an old number is refused. */
async function checkStaleRevisionRefused(fixture: Fixture): Promise<void> {
  const skill = await newestSkill(fixture);
  const result = await run(Effect.result(fixture.library.revise(fixture.agent.id, skill.id, 1, SOURCE_FOLDER)));
  assert.ok(Result.isFailure(result), "The library accepted a stale revision.");
  assert.equal(result.failure._tag, "LocalSkillFailure", "The library failed in another way.");
  assert.equal(
    message(result.failure.cause),
    sourceText("error.skill.localChanged"),
    "The library reported another error.",
  );
  assert.deepEqual(await publishedRevisions(fixture, skill.id), ["1", "2"], "The stale revision published a revision.");
}

/** The third check: an install writes the skill into both provider folders of the agent. */
async function checkInstallWritesProviderFolders(fixture: Fixture): Promise<void> {
  const skill = await newestSkill(fixture);
  const installed = await run(
    fixture.service.installLocal({ agentId: fixture.agent.id, skillId: skill.id, revision: 1 }),
  );
  assert.equal(installed.skillId, skill.id, "The install reported another skill.");
  assert.equal(installed.installedVersion, 1, "The install reported another revision.");
  assert.equal(installed.availableVersion, 1, "The install reported another available revision.");
  assert.equal(installed.state, "installed", "The install reported another state.");
  assert.equal(installed.origin, "local", "The install reported another origin.");
  assert.equal(installed.enabled, true, "The install reported a disabled skill.");
  // The copy holds the revision that was asked for, not the newest one of the library.
  await assertInstalled(fixture, FIRST, FIRST_NOTES);

  const entry = await lockEntry(fixture, skill.id);
  assert.equal(entry.version, 1, "The lock file holds another revision.");
  assert.deepEqual(
    Object.keys(entry.files).sort(),
    ["SKILL.md", "references/notes.md"],
    "The lock file holds other files.",
  );

  // The newest revision installs over the copy that the agent holds.
  const updated = await run(
    fixture.service.installLocal({ agentId: fixture.agent.id, skillId: skill.id, revision: 2 }),
  );
  assert.equal(updated.installedVersion, 2, "The install reported another revision.");
  assert.equal(updated.state, "installed", "The install reported another state.");
  await assertInstalled(fixture, SECOND, SECOND_NOTES);
  assert.equal((await lockEntry(fixture, skill.id)).version, 2, "The lock file holds another revision.");
}

/** The fourth check: an installed copy does not follow a new revision of the skill. */
async function checkInstalledCopyKeepsItsRevision(fixture: Fixture): Promise<void> {
  const skill = await newestSkill(fixture);
  await writeSource(fixture, THIRD, THIRD_NOTES);
  const revised = await run(fixture.library.revise(fixture.agent.id, skill.id, 2, SOURCE_FOLDER));
  assert.equal(revised.version, 3, "The library published another revision.");

  await assertInstalled(fixture, SECOND, SECOND_NOTES);
  assert.equal((await lockEntry(fixture, skill.id)).version, 2, "The lock file followed the new revision.");

  const listed = await run(fixture.service.listInstalled(fixture.agent.id));
  assert.equal(listed.length, 1, "The agent holds another number of skills.");
  assert.equal(listed[0]?.installedVersion, 2, "The agent holds another revision.");
  assert.equal(listed[0]?.availableVersion, 3, "The agent holds another available revision.");
  assert.equal(listed[0]?.state, "update-available", "The agent holds another state.");
}

/** The fifth check: a file the user changed is never overwritten. */
async function checkModifiedFileIsNotOverwritten(fixture: Fixture): Promise<void> {
  const skill = await newestSkill(fixture);
  const changed = join(fixture.workspace, PROVIDER_FOLDERS[0], SLUG, "SKILL.md");
  await writeFile(changed, USER_EDIT);

  const result = await run(
    Effect.result(fixture.service.installLocal({ agentId: fixture.agent.id, skillId: skill.id, revision: 3 })),
  );
  assert.ok(Result.isFailure(result), "The install overwrote a file the user changed.");
  assert.equal(result.failure._tag, "SkillMarketplaceFailure", "The install failed in another way.");
  assert.equal(
    message(result.failure.cause),
    sourceText("error.skill.replaceModified"),
    "The install reported another error.",
  );

  assert.equal(await readFile(changed, "utf8"), USER_EDIT, "The file of the user changed.");
  assert.equal(
    await readFile(join(fixture.workspace, PROVIDER_FOLDERS[1], SLUG, "SKILL.md"), "utf8"),
    SECOND,
    "The other copy of the skill changed.",
  );
  assert.equal((await lockEntry(fixture, skill.id)).version, 2, "The lock file holds another revision.");
}

/** The sixth check: a confirmed replacement writes the newest revision over the changed file. */
async function checkConfirmedReplacementWritesTheNewRevision(fixture: Fixture): Promise<void> {
  const skill = await newestSkill(fixture);
  const installed = await run(
    fixture.service.install({ agentId: fixture.agent.id, skillId: skill.id, replaceModified: true }),
  );
  assert.equal(installed.installedVersion, 3, "The install reported another revision.");
  await assertInstalled(fixture, THIRD, THIRD_NOTES);
  assert.equal((await lockEntry(fixture, skill.id)).version, 3, "The lock file holds another revision.");

  const listed = await run(fixture.service.listInstalled(fixture.agent.id));
  assert.equal(listed.length, 1, "The agent holds another number of skills.");
  assert.equal(listed[0]?.installedVersion, 3, "The agent holds another revision.");
  assert.equal(listed[0]?.availableVersion, 3, "The agent holds another available revision.");
  assert.equal(listed[0]?.state, "installed", "The agent holds another state.");
}

interface Report {
  status: "running" | "passed" | "failed";
  checks: Array<{ name: string; status: "passed" | "failed" }>;
  error?: string;
}

const reportPath = fileURLToPath(new URL("../.openbot-build/local-skill-library-e2e/report.json", import.meta.url));
const world = await fixture();
const report: Report = { status: "running", checks: [] };
let activeCheck: string | undefined;
try {
  const checks: Array<[string, (fixture: Fixture) => Promise<void>]> = [
    ["create-and-revise", checkCreateAndRevise],
    ["stale-revision-refused", checkStaleRevisionRefused],
    ["install-writes-provider-folders", checkInstallWritesProviderFolders],
    ["installed-copy-keeps-its-revision", checkInstalledCopyKeepsItsRevision],
    ["modified-file-is-not-overwritten", checkModifiedFileIsNotOverwritten],
    ["confirmed-replacement-writes-the-new-revision", checkConfirmedReplacementWritesTheNewRevision],
  ];
  for (const [name, check] of checks) {
    activeCheck = name;
    await check(world);
    report.checks.push({ name, status: "passed" });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  if (activeCheck) report.checks.push({ name: activeCheck, status: "failed" });
  report.error = failureText(error);
  process.exitCode = 1;
} finally {
  await rm(world.root, { recursive: true, force: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
