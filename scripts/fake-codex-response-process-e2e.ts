/** Text the fake Codex streams as a delta and must keep after an empty reasoning completion. */
export const STREAMED_NOTE_TEXT = "Keep the streamed note.";

/** Text the fake Codex streams through a text-block summary part. */
export const BLOCK_SUMMARY_TEXT = "Block summary text";

/** Final answer text from the fake Codex turn. */
export const FINAL_ANSWER_TEXT = "Done.";

/**
 * A Codex app-server for response-process E2E checks. It streams reasoning with a text-block summary
 * and a delta note, completes the reasoning item with an empty summary, then sends the final answer.
 */
export const FAKE_CODEX_RESPONSE_PROCESS = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.162.1\\n");
  process.exit(0);
}
let buffer = "";
let turns = 0;
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-5.5", displayName: "GPT-5.5" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "process-thread", turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "process-turn-" + (++turns);
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      setTimeout(() => {
        const blockId = "block-summary-" + turnId;
        const streamId = "streamed-note-" + turnId;
        write({ method: "item/started", params: { threadId: params.threadId, turnId, item: { type: "reasoning", id: blockId, summary: [] } } });
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "reasoning", id: blockId, summary: [{ type: "summary_text", text: ${JSON.stringify(BLOCK_SUMMARY_TEXT)} }] } } });
        write({ method: "item/started", params: { threadId: params.threadId, turnId, item: { type: "reasoning", id: streamId, summary: [] } } });
        write({ method: "item/reasoning/summaryTextDelta", params: { threadId: params.threadId, turnId, itemId: streamId, delta: ${JSON.stringify(STREAMED_NOTE_TEXT)} } });
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "reasoning", id: streamId, summary: [] } } });
        write({ method: "item/completed", params: { threadId: params.threadId, turnId, item: { type: "agentMessage", id: "answer-" + turnId, text: ${JSON.stringify(FINAL_ANSWER_TEXT)}, phase: "final_answer" } } });
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: turnId, status: "completed" } } });
      }, 2_000);
      return;
    }
    case "turn/interrupt": return write({ id: message.id, result: {} });
    default: return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
    }
    newline = buffer.indexOf("\\n");
  }
});
`;
