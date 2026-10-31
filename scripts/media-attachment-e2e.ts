// Checks the media attachments and the size limits the README promises. An MP3 and a MOV file are
// stored unchanged with their own MIME type, a file over 100 MB is refused, a message over 250 MB
// is refused, an eleventh file is refused, and a host without the `media-attachments` capability
// refuses the file.
//
// The check runs the real services on a temporary profile: the database, the mailbox store, the
// attachment file service and the IPC handlers of the main process. The byte limits are large, so
// the files that reach them are sparse: they hold their size, not their bytes.
//
// Run: `bun scripts/media-attachment-e2e.ts`.
// Writes .openbot-build/media-attachment-e2e/report.json.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSupportedAttachmentName,
  isOpenableAttachmentName,
  isSupportedAttachmentNameFor,
  playableMediaKind,
  supportedAttachmentExtensions,
} from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type DraftAttachment, type ImportAttachmentsInput, LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import {
  TEAM_EML_ATTACHMENTS_CAPABILITY,
  TEAM_MEDIA_ATTACHMENTS_CAPABILITY,
  TEAM_MP4_ATTACHMENTS_CAPABILITY,
  TEAM_ZIP_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/current";
import { translateFor } from "@openbot/i18n";
import { sourceText } from "@openbot/i18n/source";
import { plugin } from "bun";
import { Effect } from "effect";
import { AgentLifecycleFailed } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const workspace = dirname(dirname(import.meta.filename));
const artifactPath = join(workspace, ".openbot-build", "media-attachment-e2e", "report.json");

/** The host of the check that answers every capability. */
const MODERN_HOST = "host-with-media";
/** The host of the check that answers every capability except the media one. */
const OLD_HOST = "host-without-media";
/** What the old host answers. It takes everything but a recording. */
const OLD_HOST_CAPABILITIES = new Set<string>([
  TEAM_EML_ATTACHMENTS_CAPABILITY,
  TEAM_ZIP_ATTACHMENTS_CAPABILITY,
  TEAM_MP4_ATTACHMENTS_CAPABILITY,
]);

/** The bytes of a small MP3 file. The app never decodes a recording, so the header is enough. */
const mp3Bytes = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** The `ftyp` box that starts a QuickTime file. */
const movBytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x71, 0x74, 0x20,
  0x00,
]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file that holds its size and no data: the disk writes a hole and the reader reads zeros. */
async function sparseFile(path: string, bytes: number): Promise<void> {
  await writeFile(path, new Uint8Array(0));
  await truncate(path, bytes);
}

/** The IPC listener of one channel, as the main process registers it. */
type CapturedListener = (
  event: { senderFrame: { url: string } },
  payload: unknown,
) => DraftAttachment[] | Promise<DraftAttachment[]>;

/** The file the host received, as the fake remote server records it. */
interface UploadedFile {
  name: string;
  mimeType: string;
  bytes: number;
}

// The main process imports Electron for its windows and its dialogs. This check opens no window:
// it calls the attachment endpoint of the main process and reads what it answers.
const captured = new Map<string, CapturedListener>();
plugin({
  name: "media-attachment-electron-boundary",
  setup(build) {
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app: { getPath: () => tmpdir(), getVersion: () => "0.0.0-e2e" },
        dialog: {
          showOpenDialog: () => ({ canceled: true, filePaths: [] }),
          showSaveDialog: () => ({ canceled: true }),
        },
        shell: { showItemInFolder: () => undefined, openPath: () => "" },
        ipcMain: {
          handle: (channel: string, listener: CapturedListener) => {
            captured.set(channel, listener);
          },
          removeHandler: () => undefined,
          on: () => undefined,
        },
      },
    }));
  },
});

// The modules below import Electron, so they load after the stub above.
const { IPC_ENDPOINTS } = await import("@openbot/contracts/ipc");
const { registerIpcGroup } = await import("../src/main/ipc/define-ipc-group");
const { attachmentIpcHandlers } = await import("../src/main/ipc/attachment-handlers");

const importChannel = IPC_ENDPOINTS.attachmentImports.importAttachments.channel;
/** The frame the main process trusts. The renderer of the app sends from this one. */
const rendererFrameUrl = process.env.ELECTRON_RENDERER_URL ?? "openbot-app://app/index.html";

async function run() {
  const results: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "openbot-media-attachment-"));
  const userData = join(root, "user-data");
  const database = new OpenBotDatabase(userData);
  try {
    await mkdir(userData, { recursive: true });
    const store = new AgentStore(userData, join(root, "home"), database);
    const mailbox = new MailboxStore(userData, store.sharedRoot, database);
    await runCauseEffect(store.initialize());
    await runCauseEffect(mailbox.initialize());
    const sources = join(root, "sources");
    await mkdir(sources, { recursive: true });

    /** The files the fake remote server received. */
    const uploads: UploadedFile[] = [];
    const remoteServers = {
      supportsCapability: (serverId: string, capability: string) =>
        serverId !== OLD_HOST || OLD_HOST_CAPABILITIES.has(capability),
      request: () => Effect.die("Not used by this check."),
      downloadAttachment: () => Effect.die("Not used by this check."),
      downloadSharedFile: () => Effect.die("Not used by this check."),
      downloadWorkspaceFile: () => Effect.die("Not used by this check."),
      uploadAttachment: (name: string, mimeType: string, bytes: Uint8Array) => {
        uploads.push({ name, mimeType, bytes: bytes.byteLength });
        return Effect.succeed({
          id: `remote-${uploads.length}`,
          name,
          size: bytes.byteLength,
          kind: "file" as const,
          mimeType,
          previewKind: "none" as const,
          previewUrl: null,
        });
      },
    };
    const service = {
      prepareAttachments: (paths: string[]) =>
        mailbox.prepareAttachments(paths).pipe(Effect.mapError(toLifecycleFailure("prepareAttachments"))),
      prepareImportedAttachments: (paths: string[], data: ImportAttachmentsInput["data"]) =>
        mailbox
          .prepareImportedAttachments(paths, data)
          .pipe(Effect.mapError(toLifecycleFailure("prepareImportedAttachments"))),
      discardDraftAttachment: (attachmentId: string) =>
        mailbox.discardDraft(attachmentId).pipe(Effect.mapError(toLifecycleFailure("discardDraftAttachment"))),
      resolveSharedFile: () => Effect.die("Not used by this check."),
      resolveLocalWorkspaceFile: () => Effect.die("Not used by this check."),
      listLocalWorkspaceDirectory: () => Effect.die("Not used by this check."),
    };
    const handlers = attachmentIpcHandlers({
      service,
      mailbox,
      remoteServers,
      getMainWindow: () => null,
      translate: translateFor("en"),
    });
    registerIpcGroup("attachmentImports", handlers.attachmentImports);

    /** The message a refusal carries. The check reads the text the user reads. */
    const refusalMessage = async (operation: () => Promise<DraftAttachment[]>): Promise<string> => {
      try {
        await operation();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("The attachment was not refused.");
    };

    // The user attaches a recording. Both files are stored unchanged, with the MIME type of their
    // own kind, and the chat plays them instead of showing a preview.
    const mp3Path = join(sources, "interview.mp3");
    const movPath = join(sources, "walkthrough.mov");
    await writeFile(mp3Path, mp3Bytes);
    await writeFile(movPath, movBytes);
    const drafts = await importLocal([mp3Path, movPath]);
    assert.equal(drafts.length, 2);
    const [mp3Draft, movDraft] = drafts;
    assert.ok(mp3Draft && movDraft);
    assert.equal(mp3Draft.name, "interview.mp3");
    assert.equal(mp3Draft.mimeType, "audio/mpeg");
    assert.equal(mp3Draft.kind, "file");
    assert.equal(mp3Draft.previewKind, "none");
    assert.equal(mp3Draft.size, mp3Bytes.byteLength);
    assert.equal(movDraft.name, "walkthrough.mov");
    assert.equal(movDraft.mimeType, "video/quicktime");
    assert.equal(movDraft.kind, "file");
    assert.equal(movDraft.previewKind, "none");
    assert.equal(movDraft.size, movBytes.byteLength);
    assert.equal(playableMediaKind(mp3Draft.mimeType), "audio");
    assert.equal(playableMediaKind(movDraft.mimeType), "video");
    assert.deepEqual(await readFile(draftPath(userData, mp3Draft)), Buffer.from(mp3Bytes));
    assert.deepEqual(await readFile(draftPath(userData, movDraft)), Buffer.from(movBytes));
    results.push("An MP3 and a MOV file are stored unchanged, with the MIME type of their own kind.");

    // The desktop app opens a recording with the default app of the operating system.
    assert.equal(isOpenableAttachmentName("interview.mp3"), true);
    assert.equal(isOpenableAttachmentName("walkthrough.mov"), true);
    assert.doesNotThrow(() => assertSupportedAttachmentName("interview.mp3"));
    assert.doesNotThrow(() => assertSupportedAttachmentName("walkthrough.mov"));
    results.push("The desktop app opens a recording with the default app of the operating system.");

    // A file of exactly 100 MB is inside the limit, and one byte more is not.
    const atLimit = join(sources, "at-limit.mp3");
    await sparseFile(atLimit, ATTACHMENT_LIMITS.fileBytes);
    const atLimitDrafts = await importLocal([atLimit]);
    assert.equal(atLimitDrafts.length, 1);
    assert.equal(atLimitDrafts[0]?.size, ATTACHMENT_LIMITS.fileBytes);
    const overLimit = join(sources, "over-limit.mp3");
    await sparseFile(overLimit, ATTACHMENT_LIMITS.fileBytes + 1);
    assert.equal(
      await refusalMessage(() => importLocal([overLimit])),
      sourceText("error.attachment.namedFileTooLarge", { name: "over-limit.mp3" }),
    );
    results.push("A file of 100 MB is stored and a file of one byte more is refused.");

    // Three files of 84 MB are 252 MB together, which is over the 250 MB of one message.
    const bigFiles = await Promise.all(
      ["first.mp3", "second.mp3", "third.mp3"].map(async (name) => {
        const path = join(sources, name);
        await sparseFile(path, 84 * 1024 * 1024);
        return path;
      }),
    );
    assert.equal(await refusalMessage(() => importLocal(bigFiles)), sourceText("error.attachment.totalTooLarge"));
    results.push("A message of 252 MB is refused, and every file of it stays under the 100 MB limit.");

    // Ten files are inside the limit of one message and an eleventh is not.
    const manyFiles = await Promise.all(
      Array.from({ length: INPUT_LIMITS.attachments }, async (_unused, index) => {
        const path = join(sources, `note-${index}.mp3`);
        await writeFile(path, new Uint8Array([index]));
        return path;
      }),
    );
    const eleventh = join(sources, "eleventh.mp3");
    await writeFile(eleventh, new Uint8Array([INPUT_LIMITS.attachments]));
    const tenDrafts = await importLocal(manyFiles);
    assert.equal(tenDrafts.length, INPUT_LIMITS.attachments);
    assert.equal(
      await refusalMessage(() => importLocal([...manyFiles, eleventh])),
      sourceText("error.attachment.tooMany", { limit: INPUT_LIMITS.attachments }),
    );
    // The store refuses the eleventh file on its own, not only the IPC boundary in front of it.
    assert.equal(
      await refusalMessage(() => runCauseEffect(mailbox.prepareImportedAttachments([...manyFiles, eleventh], []))),
      sourceText("error.attachment.tooMany", { limit: INPUT_LIMITS.attachments }),
    );
    results.push("Ten files are stored and an eleventh file is refused.");

    // A host without the `media-attachments` capability refuses the recording, and a host with it
    // receives the file.
    assert.equal(remoteServers.supportsCapability(OLD_HOST, TEAM_MEDIA_ATTACHMENTS_CAPABILITY), false);
    assert.equal(remoteServers.supportsCapability(MODERN_HOST, TEAM_MEDIA_ATTACHMENTS_CAPABILITY), true);
    assert.equal(
      await refusalMessage(() => importRemote([mp3Path], OLD_HOST)),
      sourceText("error.attachment.mediaUnsupported"),
    );
    assert.equal(
      await refusalMessage(() => importRemote([movPath], OLD_HOST)),
      sourceText("error.attachment.mediaUnsupported"),
    );
    assert.equal(uploads.length, 0);
    const remoteDrafts = await importRemote([mp3Path], MODERN_HOST);
    assert.equal(remoteDrafts.length, 1);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.name, "interview.mp3");
    assert.equal(uploads[0]?.mimeType, "audio/mpeg");
    assert.equal(uploads[0]?.bytes, mp3Bytes.byteLength);
    results.push(
      "A host without the media-attachments capability refuses a recording, and a host with it receives it.",
    );

    // The file picker of that host offers no recording either.
    const oldHostSupport = { eml: true, media: false, zip: true, mp4: true };
    assert.equal(supportedAttachmentExtensions(oldHostSupport).includes("mp3"), false);
    assert.equal(supportedAttachmentExtensions(oldHostSupport).includes("mov"), false);
    assert.equal(isSupportedAttachmentNameFor("interview.mp3", oldHostSupport), false);
    assert.equal(isSupportedAttachmentNameFor("walkthrough.mov", oldHostSupport), false);
    assert.equal(isSupportedAttachmentNameFor("interview.mp3", { ...oldHostSupport, media: true }), true);
    results.push("The file picker of a host without the media-attachments capability offers no recording.");

    // The same limits hold for a host that receives the file.
    assert.equal(
      await refusalMessage(() => importRemote([overLimit], MODERN_HOST)),
      sourceText("error.attachment.fileTooLarge"),
    );
    assert.equal(
      await refusalMessage(() => importRemote(bigFiles, MODERN_HOST)),
      sourceText("error.attachment.totalTooLarge"),
    );
    assert.equal(
      await refusalMessage(() => importRemote([...manyFiles, eleventh], MODERN_HOST)),
      sourceText("error.attachment.tooMany", { limit: INPUT_LIMITS.attachments }),
    );
    results.push("A host refuses a file over 100 MB, a message over 250 MB and an eleventh file.");

    return {
      status: "pass",
      results,
      stored: await Promise.all(
        drafts.map(async (draft) => ({
          name: draft.name,
          mimeType: draft.mimeType,
          kind: draft.kind,
          previewKind: draft.previewKind,
          size: draft.size,
          sha256: digest(await readFile(draftPath(userData, draft))),
        })),
      ),
      limits: {
        fileBytes: ATTACHMENT_LIMITS.fileBytes,
        totalBytes: ATTACHMENT_LIMITS.totalBytes,
        files: INPUT_LIMITS.attachments,
      },
      uploads,
    };
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** The file the draft service wrote for one draft. */
function draftPath(userData: string, draft: DraftAttachment): string {
  return join(userData, "attachment-drafts", draft.id, draft.name);
}

/** The failure the agent service reports when the mailbox store refuses a file. */
function toLifecycleFailure(operation: string) {
  return (failure: { cause: unknown }) => new AgentLifecycleFailed({ operation, cause: failure.cause });
}

const importChannelListener = (): CapturedListener => {
  const listener = captured.get(importChannel);
  if (!listener) throw new Error("The attachment import channel has no handler.");
  return listener;
};

/** The renderer of the app sends the files of the drop or of the picker to the local host. */
async function importLocal(paths: string[]): Promise<DraftAttachment[]> {
  const listener = importChannelListener();
  return await listener(
    { senderFrame: { url: rendererFrameUrl } },
    { serverId: LOCAL_SERVER_ID, payload: { paths, data: [] } },
  );
}

/** The renderer of the app sends the files to another host of the team. */
async function importRemote(paths: string[], serverId: string): Promise<DraftAttachment[]> {
  const listener = importChannelListener();
  return await listener({ senderFrame: { url: rendererFrameUrl } }, { serverId, payload: { paths, data: [] } });
}

await mkdir(dirname(artifactPath), { recursive: true });
try {
  const report = await run();
  await writeFile(
    artifactPath,
    `${JSON.stringify(
      { ...report, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim() },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Media attachment E2E passed. Report: ${artifactPath}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(artifactPath, `${JSON.stringify({ status: "fail", error: message }, null, 2)}\n`);
  process.stderr.write(`Media attachment E2E failed: ${message}\n`);
  process.exitCode = 1;
}
