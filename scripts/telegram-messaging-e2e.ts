// Checks the Telegram connection: a chat links with a one-use code, a mention and a reply in a
// chain reach the Telegram Orchestrator, a direct chat and a forum topic get their own
// conversation, the answer goes back to the same chat and thread, a file that arrives is given to
// the agent, and a file over the 20 MB limit is refused. Runs the real Telegram transport, driver
// and messaging service on a temporary profile. The Bot API is a fake on loopback: no token, no
// network. `bun scripts/telegram-messaging-e2e.ts`.
// Writes .openbot-build/telegram-messaging-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  TELEGRAM_FILE_BYTES_LIMIT,
  type TelegramCallMethod,
  type TelegramCallParams,
  type TelegramCallResult,
} from "@openbot/contracts/signal-protocol/telegram-route";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Exit, Scope } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { type MessagingCredentials, MessagingService } from "../src/backend/messaging/messaging-service";
import { MessagingThreads } from "../src/backend/messaging/messaging-threads";
import {
  type IngressHandler,
  MessagingAdapterError,
  type MessagingIngress,
  TelegramCallError,
  type TelegramGateway,
} from "../src/backend/messaging/messaging-types";
import { telegramDriver } from "../src/backend/messaging/telegram/telegram-driver";
import { telegramHtml } from "../src/backend/messaging/telegram/telegram-render";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/telegram-messaging-e2e");
const REPORT = join(OUT, "report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-telegram-messaging-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const BOT_ID = "7700000000000001";
const BOT_USERNAME = "openbot_bot";
/** The one-use code of a link. Its shape is the one that the Telegram route accepts. */
const LINK_CODE = "telegram-e2e-link-code-000000000000";
const GROUP = "-1001234567890";
const DIRECT = "555000111";
const FORUM = "-1009876543210";
const ADA = "500000111";
const BOB = "500000222";
/** The thread of a supergroup, and the topic of a forum. */
const THREAD = 777;
const TOPIC = 42;

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { steps: Step[]; passed: boolean; unverified: string[] } = {
  steps: [],
  passed: false,
  unverified: [
    "The Bot API of Telegram and the Signal relay that holds the bot token: a fake Bot API on loopback stands in for both.",
    "The account service half of a link: the check gives the one-use code itself.",
    "An agent turn: no provider runs, so the check writes the answer of the orchestrator into the conversation.",
  ],
};

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  const entry: Step = { name, passed: false };
  report.steps.push(entry);
  try {
    entry.detail = await run();
    entry.passed = true;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/** No step needs the browser: a call to it is a failure. */
const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
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

// The fake Bot API: what Telegram answered to the calls of the host.
interface BotApiCall {
  method: string;
  params: DynamicRecord;
  result: BotApiResult;
}

/** The parts of a Bot API answer that the check reads. */
interface BotApiResult {
  id?: number;
  username?: string;
  message_id?: number;
  file_id?: string;
  file_size?: number;
  file_path?: string;
}

/** The answer of the fake Bot API, as the host reads it. */
interface BotApiAnswer {
  ok: boolean;
  result?: BotApiResult;
  error_code?: number;
  description?: string;
}

/** The answer of the upload of one file. */
interface UploadAnswer {
  ok: boolean;
  messageId: number | null;
}

const botApiCalls: BotApiCall[] = [];
const botApiUploads: { name: string; bytes: number }[] = [];
/** The files that the fake Bot API can give, by file id. */
const botApiFiles = new Map<string, Uint8Array>();
const waiters: Array<{ match: (call: BotApiCall) => boolean; resolve: () => void }> = [];
let nextMessageId = 900;

function botApiAnswer(response: ServerResponse, body: BotApiAnswer): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

/** The answer of one Bot API method, as Telegram gives it. */
function botApiResult(method: string, params: DynamicRecord): BotApiResult {
  switch (method) {
    case "getMe":
      return { id: Number(BOT_ID), username: BOT_USERNAME };
    case "sendMessage":
      return { message_id: nextMessageId++ };
    case "editMessageText":
      return { message_id: isNumber(params.message_id) ? params.message_id : undefined };
    case "getFile": {
      const fileId = isString(params.file_id) ? params.file_id : "";
      const file = botApiFiles.get(fileId);
      return { file_id: fileId, file_size: file?.byteLength ?? 0, file_path: `documents/${fileId}` };
    }
    case "sendDocument":
      // Signal gives the host an upload token, and the host posts the bytes to it.
      return { file_id: `upload-${nextMessageId++}` };
    default:
      return {};
  }
}

/** The parts of an answer that the check reads, parsed from the JSON of the fake Bot API. */
function botApiResultOf(value: DynamicRecord): BotApiResult {
  return {
    ...(isNumber(value.id) ? { id: value.id } : {}),
    ...(isString(value.username) ? { username: value.username } : {}),
    ...(isNumber(value.message_id) ? { message_id: value.message_id } : {}),
    ...(isString(value.file_id) ? { file_id: value.file_id } : {}),
    ...(isNumber(value.file_size) ? { file_size: value.file_size } : {}),
    ...(isString(value.file_path) ? { file_path: value.file_path } : {}),
  };
}

/** The Bot API of Telegram, on loopback. It knows no token and reaches no network. */
async function startFakeBotApi(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);
      if (url.pathname.startsWith("/bot")) {
        const method = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
        const parsed = body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : {};
        const params: DynamicRecord = isDynamicRecord(parsed) ? parsed : {};
        const result = botApiResult(method, params);
        const call: BotApiCall = { method, params, result };
        botApiCalls.push(call);
        for (const waiter of waiters.splice(0)) {
          if (waiter.match(call)) waiter.resolve();
          else waiters.push(waiter);
        }
        botApiAnswer(response, { ok: true, result });
        return;
      }
      if (url.pathname.startsWith("/file/")) {
        const fileId = url.pathname.slice("/file/".length).replace(/^documents\//u, "");
        const file = botApiFiles.get(fileId);
        if (!file) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(file));
        return;
      }
      if (url.pathname.startsWith("/upload/")) {
        botApiUploads.push({ name: String(request.headers["x-file-name"] ?? "file"), bytes: body.byteLength });
        botApiAnswer(response, { ok: true, result: { message_id: nextMessageId++ } });
        return;
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object", "The fake Bot API has no port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** Fails after 15 seconds, so a call that never comes fails the check instead of holding it. */
function waitForCall(match: (call: BotApiCall) => boolean): Promise<void> {
  if (botApiCalls.some(match)) return Promise.resolve();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("The expected Bot API call did not come.")), 15_000);
    waiters.push({
      match,
      resolve: () => {
        clearTimeout(timer);
        done();
      },
    });
  });
}

const callsOf = (method: string) => botApiCalls.filter((call) => call.method === method);

/** The last call that matches, or null. */
function lastCall(calls: BotApiCall[], match: (call: BotApiCall) => boolean): BotApiCall | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call && match(call)) return call;
  }
  return null;
}

/** The reduced result of a call, as the host gets it from Signal. */
function botApiCallResult(method: string, result: BotApiResult | undefined): TelegramCallResult {
  const value = result ?? {};
  if (method === "getMe")
    return {
      botId: isNumber(value.id) ? String(value.id) : "",
      username: isString(value.username) ? value.username : "",
    };
  if (method === "sendMessage") return { messageId: isNumber(value.message_id) ? value.message_id : undefined };
  if (method === "getFile")
    return {
      fileToken: isString(value.file_path) ? value.file_path : undefined,
      fileSize: isNumber(value.file_size) ? value.file_size : undefined,
    };
  if (method === "sendDocument") return { uploadToken: isString(value.file_id) ? value.file_id : undefined };
  return {};
}

/** The Bot API calls of the host, over HTTP to the fake server on loopback. */
function botApiGateway(origin: string): TelegramGateway {
  const call = <M extends TelegramCallMethod>(botId: string, method: M, params: TelegramCallParams[M]) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${origin}/bot${botId}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
          }),
        catch: (cause) => new MessagingAdapterError({ cause }),
      });
      const answer = yield* Effect.tryPromise({
        try: async () => {
          const value = await response.json();
          if (!isDynamicRecord(value)) return { ok: false } satisfies BotApiAnswer;
          return {
            ok: value.ok === true,
            ...(isDynamicRecord(value.result) ? { result: botApiResultOf(value.result) } : {}),
            ...(isNumber(value.error_code) ? { error_code: value.error_code } : {}),
            ...(isString(value.description) ? { description: value.description } : {}),
          } satisfies BotApiAnswer;
        },
        catch: (cause) => new MessagingAdapterError({ cause }),
      });
      if (!answer.ok)
        return yield* new MessagingAdapterError({
          cause: new TelegramCallError(
            answer.error_code ?? 500,
            answer.description ?? "The Bot API refused the call.",
            null,
          ),
        });
      return botApiCallResult(method, answer.result);
    });

  return {
    available: () => true,
    call: <M extends TelegramCallMethod>(botId: string, method: M, params: TelegramCallParams[M]) =>
      call(botId, method, params),
    download: (fileToken, destination, maxBytes) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () => fetch(`${origin}/file/${fileToken}`),
          catch: (cause) => new MessagingAdapterError({ cause }),
        });
        if (!response.ok) return yield* new MessagingAdapterError({ cause: new Error("file_unavailable") });
        const bytes = new Uint8Array(
          yield* Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: (cause) => new MessagingAdapterError({ cause }),
          }),
        );
        if (bytes.byteLength > maxBytes)
          return yield* new MessagingAdapterError({ cause: new Error("file_too_large") });
        yield* Effect.tryPromise({
          try: () => writeFile(destination, bytes),
          catch: (cause) => new MessagingAdapterError({ cause }),
        });
      }),
    upload: (uploadToken, path) =>
      Effect.gen(function* () {
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(path),
          catch: (cause) => new MessagingAdapterError({ cause }),
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${origin}/upload/${uploadToken}`, {
              method: "POST",
              headers: { "content-type": "application/octet-stream", "x-file-name": basename(path) },
              body: bytes,
            }),
          catch: (cause) => new MessagingAdapterError({ cause }),
        });
        const answer = yield* Effect.tryPromise({
          try: async () => {
            const value = await response.json();
            if (!isDynamicRecord(value)) return { ok: false, messageId: null } satisfies UploadAnswer;
            const result = isDynamicRecord(value.result) ? value.result : {};
            return {
              ok: value.ok === true,
              messageId: isNumber(result.message_id) ? result.message_id : null,
            } satisfies UploadAnswer;
          },
          catch: (cause) => new MessagingAdapterError({ cause }),
        });
        if (!answer.ok || answer.messageId === null)
          return yield* new MessagingAdapterError({ cause: new Error("upload_failed") });
        return answer.messageId;
      }),
  };
}

/** The relay as Signal drives it: the service sets one handler, and each update goes through it. */
let relayHandler: IngressHandler | null = null;
let ingress: MessagingIngress;

function relayWithGateway(gateway: TelegramGateway): MessagingIngress {
  return {
    acquire: () => () => {},
    state: () => "online",
    onState: () => () => {},
    handle: (handler) => {
      relayHandler = handler;
    },
    telegram: gateway,
    reconnect: () => {},
    discord: unused,
    onDiscordRoutes: () => () => {},
  };
}

/** The tokens of each connection, in memory. */
function memoryCredentials(): MessagingCredentials {
  const values = new Map<string, Record<string, string>>();
  return {
    keys: () => [...values.keys()],
    status: (connectionId) => (values.has(connectionId) ? "saved" : "missing"),
    get: (connectionId) => values.get(connectionId) ?? null,
    set: (connectionId, value) => Effect.sync(() => void values.set(connectionId, value)),
    clear: (connectionId) => Effect.sync(() => void values.delete(connectionId)),
    retain: (connectionIds) =>
      Effect.sync(() => {
        for (const key of values.keys()) if (!connectionIds.has(key)) values.delete(key);
      }),
  };
}

const credentials = memoryCredentials();

interface Booted {
  messaging: MessagingService;
  threads: MessagingThreads;
  mailbox: MailboxStore;
  database: OpenBotDatabase;
  driver: ReturnType<typeof telegramDriver>;
  scope: Scope.Scope;
}

async function boot<T>(use: (services: Booted) => Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agents = new AgentService({ store, mailbox, browser, sidebarLayout: sidebar });
  // Its own threads, which start no turn: no provider runs in this check.
  const threads = new MessagingThreads(store.database, mailbox, {
    schedule: () => {},
    queueChanged: () => {},
    busy: () => false,
    interrupt: unused,
    forgetThread: () => Effect.void,
    ownChat: () => false,
    contextSession: () => null,
  });
  const driver = telegramDriver({ ingress });
  const messaging = new MessagingService({
    threads,
    agents: {
      listAgents: () => agents.listAgents(),
      respondToApproval: (input) => agents.respondToApproval(input),
      onEvent: () => () => {},
      createAgentProfile: (input) => agents.createAgentProfile(input),
      createMemory: (input) => agents.createMemory(input),
      ensureDeletable: (agentId) => agents.ensureAgentDeletable(agentId),
      deleteAgent: (agentId) => agents.deleteAgent(agentId),
      sidebarChatIds: () => agents.sidebarChatIds(),
    },
    credentials,
    drivers: [driver],
    downloadsRoot: join(userData, "messaging-downloads"),
    ingress,
    telegramApp: {
      createLink: () => Effect.succeed({ botUsername: BOT_USERNAME, code: LINK_CODE }),
      unlink: () => Effect.void,
      openExternal: async () => {},
    },
    sidebar,
  });
  await runCauseEffect(messaging.start());
  const scope = Scope.makeUnsafe();
  try {
    return await use({ messaging, threads, mailbox, database, driver, scope });
  } finally {
    await Scope.close(scope, Exit.void);
    await runCauseEffect(messaging.stop());
    await runCauseEffect(agents.stop());
    database.close();
  }
}

interface Chat {
  id: string;
  type: "group" | "supergroup" | "private";
  title?: string;
  isForum?: boolean;
}

const GROUP_CHAT: Chat = { id: GROUP, type: "supergroup", title: "Team" };
const DIRECT_CHAT: Chat = { id: DIRECT, type: "private" };
const FORUM_CHAT: Chat = { id: FORUM, type: "supergroup", title: "Forum", isForum: true };

let updateId = 1;

function chatOf(chat: Chat): DynamicRecord {
  return {
    id: Number(chat.id),
    type: chat.type,
    ...(chat.title ? { title: chat.title } : {}),
    ...(chat.isForum ? { is_forum: true } : {}),
  };
}

/** One update as Telegram posts it. */
function messageUpdate(options: {
  chat: Chat;
  messageId: number;
  text: string;
  author?: string;
  mention?: boolean;
  threadId?: number;
  topicMessage?: boolean;
  replyTo?: { messageId: number; from: "bot" | "user" };
  document?: { fileId: string; fileName: string; size: number };
}): DynamicRecord {
  const text = options.mention ? `@${BOT_USERNAME} ${options.text}` : options.text;
  const author = options.author ?? ADA;
  return {
    update_id: updateId++,
    message: {
      message_id: options.messageId,
      date: 1_760_000_000,
      chat: chatOf(options.chat),
      from: { id: Number(author), is_bot: false, first_name: author === ADA ? "Ada" : "Bob" },
      text,
      ...(options.mention ? { entities: [{ type: "mention", offset: 0, length: BOT_USERNAME.length + 1 }] } : {}),
      ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
      ...(options.topicMessage ? { is_topic_message: true } : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              message_id: options.replyTo.messageId,
              date: 1_760_000_000,
              chat: chatOf(options.chat),
              from:
                options.replyTo.from === "bot"
                  ? { id: Number(BOT_ID), is_bot: true, first_name: "OpenBot", username: BOT_USERNAME }
                  : { id: Number(author), is_bot: false, first_name: author === ADA ? "Ada" : "Bob" },
            },
          }
        : {}),
      ...(options.document
        ? {
            document: {
              file_id: options.document.fileId,
              file_name: options.document.fileName,
              mime_type: "text/plain",
              file_size: options.document.size,
            },
          }
        : {}),
    },
  };
}

/** The update that links a chat to this host. */
function startUpdate(chat: Chat): DynamicRecord {
  const id = updateId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_760_000_000,
      chat: chatOf(chat),
      from: { id: Number(ADA), is_bot: false, first_name: "Ada", username: "ada" },
      text: `/start ${LINK_CODE}`,
    },
  };
}

/** One update of a chat, as the relay passes it on. */
async function deliver(chatId: string, update: DynamicRecord, linked = false): Promise<void> {
  const handler = relayHandler;
  assert.ok(handler, "The messaging service has no relay handler.");
  const answer = await runCauseEffect(
    handler(chatId, {
      platform: "telegram",
      botId: BOT_ID,
      body: new TextEncoder().encode(JSON.stringify(update)),
      linked,
    }),
  );
  assert.equal(answer.status, 200);
}

/** Links a chat with a one-use code, as the account service does. */
async function linkChat(services: Booted, chat: Chat, place: "group" | "direct"): Promise<void> {
  const page = await runCauseEffect(services.messaging.connectTelegramChat(place, false));
  assert.ok(page.url.includes(LINK_CODE), "The link has no one-use code.");
  await deliver(chat.id, startUpdate(chat), true);
  const connection = services.messaging
    .telegramOverview()
    .connections.find((candidate) => candidate.workspaceId === chat.id);
  assert.ok(connection, "The chat is not in the overview.");
  assert.equal(connection.state, "connected", "The chat did not connect.");
}

/** The conversation of a message, and the agent that answers it. */
function conversationOf(services: Booted, chatId: string, threadKey: string) {
  const record = services.threads.store.connectionForWorkspace("telegram", chatId);
  assert.ok(record, "The chat has no connection.");
  const link = services.threads.store.linkByKey(record.connectionId, chatId, threadKey);
  assert.ok(link, "The message has no conversation.");
  return { record, link };
}

/**
 * Runs the turn of the orchestrator that a message started, without a provider: the check writes
 * the answer into the conversation, as a turn of the agent would.
 */
async function runTurn(
  services: Booted,
  options: { chatId: string; messageId: number; threadKey: string; answer: string },
): Promise<{ working: BotApiCall; answer: BotApiCall }> {
  const { record, link } = conversationOf(services, options.chatId, options.threadKey);
  const context = services.mailbox.deliveryForKey(
    `messaging:${record.connectionId}:${options.chatId}:${options.messageId}`,
  );
  assert.ok(context, "The message has no delivery.");
  const turnId = `turn-${options.messageId}`;
  await runCauseEffect(services.mailbox.markStarting(context.delivery.id));
  await runCauseEffect(services.mailbox.markRunning(context.delivery.id, turnId));
  const started = services.threads.event(
    { type: "turn-started", agentId: link.agentId, threadId: link.threadId, turnId },
    services.scope,
  );
  assert.ok(started, "The turn of the conversation did not start.");
  const workingText = sourceText("status.messaging.working");
  const inChat = (call: BotApiCall) => call.params.chat_id === Number(options.chatId);
  await waitForCall((call) => call.method === "sendMessage" && call.params.text === workingText && inChat(call));
  const working = lastCall(callsOf("sendMessage"), (call) => call.params.text === workingText && inChat(call));
  assert.ok(working, "The working post did not reach the Bot API.");
  services.database.persistConversation(
    {
      agentId: link.agentId,
      threadId: link.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: `answer-${options.messageId}`,
          turnId,
          author: "assistant",
          source: "assistant",
          text: options.answer,
          createdAt: new Date().toISOString(),
          status: "completed",
        },
      ],
    },
    "turn.completed",
  );
  const completed = services.threads.event(
    { type: "turn-completed", agentId: link.agentId, threadId: link.threadId, turnId, status: "completed" },
    services.scope,
  );
  assert.ok(completed, "The turn of the conversation did not end.");
  const answerText = telegramHtml(options.answer);
  await waitForCall((call) => call.method === "editMessageText" && call.params.text === answerText && inChat(call));
  const answer = lastCall(callsOf("editMessageText"), (call) => call.params.text === answerText && inChat(call));
  assert.ok(answer, "The answer did not reach the Bot API.");
  // The turn is over: the request of this person waits no more.
  await runCauseEffect(services.mailbox.markTerminal(context.delivery.id, "completed"));
  return { working, answer };
}

/** The emoji of a reaction call. */
function reaction(call: BotApiCall): string[] {
  const list = call.params.reaction;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => (isDynamicRecord(entry) && isString(entry.emoji) ? [entry.emoji] : []));
}

/** The callback data of the first button of a post, or null. */
function firstButton(call: BotApiCall): string | null {
  const markup = call.params.reply_markup;
  if (!isDynamicRecord(markup)) return null;
  const keyboard = markup.inline_keyboard;
  if (!Array.isArray(keyboard)) return null;
  const row = keyboard[0];
  if (!Array.isArray(row)) return null;
  const button = row[0];
  if (!isDynamicRecord(button)) return null;
  return isString(button.callback_data) ? button.callback_data : null;
}

try {
  const botApi = await startFakeBotApi();
  ingress = relayWithGateway(botApiGateway(botApi.origin));
  try {
    await boot(async (services) => {
      const { messaging } = services;
      /** The conversation of the mention in the group, which the reply in the chain must continue. */
      let groupLinkId = "";

      await step("a chat links with a one-use code, and the Bot API gives the bot its name", async () => {
        await linkChat(services, GROUP_CHAT, "group");
        assert.equal(callsOf("getMe").length, 1, "The host did not ask the Bot API for the bot.");
        const linked = lastCall(callsOf("sendMessage"), (call) =>
          String(call.params.text ?? "").includes("OpenBot is connected to this chat"),
        );
        assert.ok(linked, "The chat got no linked message.");
        assert.equal(linked.params.chat_id, Number(GROUP));
        assert.equal(linked.params.reply_parameters, undefined, "The linked message replies to a message.");
        return { calls: botApiCalls.map((call) => call.method) };
      });

      await step("one Telegram Orchestrator answers every chat", async () => {
        const added = await runCauseEffect(messaging.addTelegramOrchestrator({}));
        const connections = messaging.telegramOverview().connections;
        assert.ok(
          connections.every((connection) => connection.orchestratorAgentId === added.agentId),
          "The chat did not get the orchestrator.",
        );
        return { agentId: added.agentId };
      });

      await step("a mention reaches the orchestrator, and the reply goes to the same chain", async () => {
        const messageId = 100;
        await deliver(
          GROUP,
          messageUpdate({ chat: GROUP_CHAT, messageId, text: "hello there", mention: true, threadId: THREAD }),
        );
        await waitForCall((call) => call.method === "setMessageReaction" && call.params.message_id === messageId);
        const seen = lastCall(callsOf("setMessageReaction"), (call) => call.params.message_id === messageId);
        assert.ok(seen, "The message got no reaction.");
        assert.deepEqual(reaction(seen), ["👀"], "The message did not get the seen reaction.");
        const { record, link } = conversationOf(services, GROUP, String(THREAD));
        assert.equal(link.threadKey, String(THREAD), "The conversation is not the thread of the chat.");
        groupLinkId = link.linkId;
        const context = services.mailbox.deliveryForKey(`messaging:${record.connectionId}:${GROUP}:${messageId}`);
        assert.ok(context, "The mention has no delivery.");
        const prepared = await runCauseEffect(services.threads.prepare(context));
        assert.ok(prepared, "The delivery has no prompt.");
        assert.match(prepared.text, /--- message ---\nhello there/u);
        const { working, answer } = await runTurn(services, {
          chatId: GROUP,
          messageId,
          threadKey: String(THREAD),
          answer: "**Ready.** The answer of the orchestrator.",
        });
        assert.equal(working.params.chat_id, Number(GROUP));
        assert.deepEqual(working.params.reply_parameters, {
          message_id: messageId,
          allow_sending_without_reply: true,
        });
        const buttons = firstButton(working);
        assert.ok(buttons, "The working post has no Stop button.");
        assert.match(buttons, /^s:/u);
        assert.equal(answer.params.chat_id, Number(GROUP));
        assert.equal(answer.params.message_id, working.result.message_id, "The answer is not in the working post.");
        await waitForCall(
          (call) =>
            call.method === "setMessageReaction" &&
            call.params.message_id === messageId &&
            reaction(call).includes("👌"),
        );
        return { threadKey: link.threadKey, answer: answer.params.text };
      });

      await step("a reply in the chain reaches the same agent, without a mention", async () => {
        const messageId = 101;
        await deliver(
          GROUP,
          messageUpdate({
            chat: GROUP_CHAT,
            messageId,
            text: "and one more thing",
            author: BOB,
            threadId: THREAD,
            replyTo: { messageId: 100, from: "user" },
          }),
        );
        await waitForCall((call) => call.method === "setMessageReaction" && call.params.message_id === messageId);
        const { record, link } = conversationOf(services, GROUP, String(THREAD));
        assert.equal(link.linkId, groupLinkId, "The reply started another conversation.");
        const context = services.mailbox.deliveryForKey(`messaging:${record.connectionId}:${GROUP}:${messageId}`);
        assert.ok(context, "The reply has no delivery.");
        const prepared = await runCauseEffect(services.threads.prepare(context));
        assert.ok(prepared, "The reply has no prompt.");
        assert.match(prepared.text, /--- message ---\nand one more thing/u);
        return { linkId: link.linkId, agentId: link.agentId };
      });

      await step("a direct chat is one conversation, and its answer goes to that chat", async () => {
        await linkChat(services, DIRECT_CHAT, "direct");
        const messageId = 200;
        await deliver(DIRECT, messageUpdate({ chat: DIRECT_CHAT, messageId, text: "a private question" }));
        await waitForCall((call) => call.method === "setMessageReaction" && call.params.message_id === messageId);
        const { link } = conversationOf(services, DIRECT, "dm");
        assert.equal(link.isDirect, true, "The conversation is not a direct chat.");
        const { working } = await runTurn(services, {
          chatId: DIRECT,
          messageId,
          threadKey: "dm",
          answer: "The answer in a direct chat.",
        });
        assert.equal(working.params.chat_id, Number(DIRECT));
        assert.equal(working.params.message_thread_id, undefined, "A direct chat has no thread.");
        return { threadKey: link.threadKey };
      });

      await step("a forum topic is one conversation, and its answer goes to that topic", async () => {
        await linkChat(services, FORUM_CHAT, "group");
        const messageId = 300;
        await deliver(
          FORUM,
          messageUpdate({
            chat: FORUM_CHAT,
            messageId,
            text: "a question in a topic",
            author: BOB,
            mention: true,
            threadId: TOPIC,
            topicMessage: true,
          }),
        );
        await waitForCall((call) => call.method === "setMessageReaction" && call.params.message_id === messageId);
        const { link } = conversationOf(services, FORUM, `t${TOPIC}`);
        assert.equal(link.threadKey, `t${TOPIC}`, "The conversation is not the topic.");
        const { working } = await runTurn(services, {
          chatId: FORUM,
          messageId,
          threadKey: `t${TOPIC}`,
          answer: "The answer in a topic.",
        });
        assert.equal(working.params.message_thread_id, TOPIC, "The answer is not in the topic.");
        return { threadKey: link.threadKey };
      });

      await step("a file that arrives is given to the agent", async () => {
        const content = new TextEncoder().encode("the file of the message");
        botApiFiles.set("file-1", content);
        const messageId = 400;
        await deliver(
          GROUP,
          messageUpdate({
            chat: GROUP_CHAT,
            messageId,
            text: "look at this file",
            mention: true,
            threadId: THREAD,
            document: { fileId: "file-1", fileName: "report.txt", size: content.byteLength },
          }),
        );
        await waitForCall((call) => call.method === "setMessageReaction" && call.params.message_id === messageId);
        const { record } = conversationOf(services, GROUP, String(THREAD));
        const context = services.mailbox.deliveryForKey(`messaging:${record.connectionId}:${GROUP}:${messageId}`);
        assert.ok(context, "The message with the file has no delivery.");
        assert.deepEqual(
          context.managedAttachments.map((file) => file.name),
          ["report.txt"],
          "The agent got no file.",
        );
        return { files: context.managedAttachments.map((file) => file.name) };
      });

      await step("a file over the 20 MB limit is refused, and a file under it goes", async () => {
        const big = join(root, "big.bin");
        const small = join(root, "small.txt");
        await writeFile(big, Buffer.alloc(TELEGRAM_FILE_BYTES_LIMIT + 1));
        await writeFile(small, "a small file");
        const adapter = services.driver.createAdapter(
          { botId: BOT_ID, chatId: GROUP, botUsername: BOT_USERNAME },
          { rateLimited: () => {} },
        );
        const target = { platformChannelId: GROUP, replyThreadId: `${THREAD}:100` };
        const before = callsOf("sendDocument").length;
        const skipped = await runCauseEffect(
          adapter.upload(target, [{ name: "big.bin", path: big, mimeType: "application/octet-stream" }]),
        );
        assert.deepEqual(skipped, ["big.bin"], "The file over the limit was not refused.");
        assert.equal(callsOf("sendDocument").length, before, "The Bot API got a document over the limit.");
        const sent = await runCauseEffect(
          adapter.upload(target, [{ name: "small.txt", path: small, mimeType: "text/plain" }]),
        );
        assert.deepEqual(sent, [], "The small file was refused.");
        assert.equal(callsOf("sendDocument").length, before + 1, "The Bot API got no document.");
        assert.deepEqual(
          botApiUploads.map((upload) => upload.name),
          ["small.txt"],
          "The Bot API got the wrong file.",
        );
        return { limit: TELEGRAM_FILE_BYTES_LIMIT, uploads: botApiUploads.length };
      });
    });
  } finally {
    await botApi.close();
  }

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
// The report names steps and ids only: no message text.
assert.ok(!readFileSync(REPORT, "utf8").includes("hello there"), "The report contains message text.");
process.stdout.write(`Telegram messaging check passed. Report: ${REPORT}\n`);
