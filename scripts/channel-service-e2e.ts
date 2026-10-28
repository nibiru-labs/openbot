// Checks the channel chat controls of the desktop app: Stop, Resume, Reassign, Archive and
// Restore. It runs the real `ChannelService` on a temporary profile, with the real SQLite database
// and the real mailbox store. The provider is fake: it names the member that a task is routed to,
// and the script drives the turn of that member itself, so the checks read the durable channel
// records and the mailbox queue.
//
// It creates a channel with three members, sends a task and checks that the fake provider routed
// it to a member and that the member's queue holds the delivery, archives the channel and checks
// that a new task is refused and that the open task is stopped, restores the channel and checks
// that a task runs again, stops a task that runs and resumes it, and reassigns one task and checks
// that the other task keeps its owner and its run.
//
// Run: `bun scripts/channel-service-e2e.ts`
// Writes .openbot-build/channel-service-e2e/report.json and exits non-zero on a failure.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, Channel, ChannelCommand, ChannelTask } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { ChannelService } from "../src/backend/channel-service";
import type { ChannelAssignment } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { writeReport } from "./channel-e2e-support";

const ACTOR = { id: "local", name: "You" };
const LEAD = "agent-lead";
const SECOND = "agent-second";
const THIRD = "agent-third";
/** The fake provider names this member when it routes a task. */
const ROUTED_TO = LEAD;

function fakeAgent(id: string, name: string): AgentSummary {
  return {
    id,
    name,
    title: name,
    description: `The ${name} member of the channel.`,
    notifications: false,
    provider: "codex",
    model: "gpt-5-codex",
    reasoningEffort: "medium",
    threadId: null,
    workspacePath: "",
    preview: "",
    updatedAt: null,
    avatarSeed: name.toLowerCase(),
    avatarHue: null,
    avatarUrl: null,
  };
}

const AGENTS: AgentSummary[] = [fakeAgent(LEAD, "Lead"), fakeAgent(SECOND, "Second"), fakeAgent(THIRD, "Third")];

interface Report {
  channelId?: string;
  routing?: { owner: string | null; deliveryAgentId: string | null; deliveryStatus: string | null };
  archive?: {
    archived: boolean;
    refusal: string | null;
    newTask: boolean;
    taskState: string;
    assignmentState: string;
  };
  restore?: { archived: boolean; deliveryAgentId: string | null; deliveryStatus: string | null };
  stop?: {
    taskState: string;
    assignmentState: string;
    interruptedTurnId: string | null;
    interruptedAgentId: string | null;
    interruptedThreadId: string | null;
  };
  resume?: {
    taskState: string;
    deliveryAgentId: string | null;
    deliveryStatus: string | null;
    newDelivery: boolean;
  };
  reassign?: {
    movedOwner: string | null;
    keptOwner: string | null;
    keptAssignmentAgentId: string | null;
    keptAssignmentState: string;
  };
  checks: string[];
  errors: string[];
  failure?: string;
  passed: boolean;
}

const report: Report = { checks: [], errors: [], passed: false };
const channelId = crypto.randomUUID();

/** Waits for a value that the service reaches on its own. */
async function until<T>(label: string, read: () => T, ready: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}. Last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-channel-service-"));
const profile = join(root, "profile");
const database = new OpenBotDatabase(profile);
try {
  const mailbox = new MailboxStore(profile, join(root, "shared"), database);
  await runCauseEffect(mailbox.initialize());
  const interrupts: Array<{ agentId: string; turnId: string; threadId: string }> = [];
  const channels = new ChannelService(database, mailbox, {
    agents: () => AGENTS,
    generate: () => Effect.succeed(JSON.stringify({ agentId: ROUTED_TO })),
    schedule: () => undefined,
    interrupt: (agentId, turnId, threadId) => {
      interrupts.push({ agentId, turnId, threadId });
      return Effect.void;
    },
    busy: () => false,
    changed: () => undefined,
    error: (error) => report.errors.push(error instanceof Error ? error.message : String(error)),
  });
  report.channelId = channelId;

  const command = (input: ChannelCommand) => runCauseEffect(channels.command(input, ACTOR));
  const tasks = (): ChannelTask[] => channels.store.tasks(channelId);
  const assignments = (): ChannelAssignment[] => channels.store.assignments(channelId);
  const activeAssignments = (): ChannelAssignment[] =>
    assignments().filter((assignment) => ["starting", "running", "queued"].includes(assignment.state));
  /** The newest assignment of a task; the store keeps the earlier ones. */
  const latestAssignment = (taskId: string): ChannelAssignment | undefined =>
    assignments()
      .filter((assignment) => assignment.taskId === taskId)
      .at(-1);
  const deliveryOf = (assignment: ChannelAssignment | undefined) =>
    assignment?.deliveryId ? mailbox.getDelivery(assignment.deliveryId) : undefined;

  // 1. The channel is created, and a task without an owner is routed by the fake provider.
  await command({
    type: "save",
    operationId: crypto.randomUUID(),
    channelId,
    draft: {
      name: "E2E channel service",
      title: "",
      instructions: "Keep each answer short.",
      members: AGENTS.map((agent) => ({ agentId: agent.id })),
      leadAgentId: LEAD,
    },
  });
  await command({
    type: "send",
    operationId: crypto.randomUUID(),
    channelId,
    text: "Route this task.",
    recipientAgentId: null,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const routed = await until(
    "the routed task has an owner",
    tasks,
    (list) => list.length > 0 && list[0]?.ownerAgentId != null,
  );
  assert.equal(routed[0]?.ownerAgentId, ROUTED_TO, "The fake provider did not route the task to its member.");
  const firstAssignment = await until(
    "the routed task has an assignment",
    activeAssignments,
    (list) => list.length === 1,
  );
  const firstDelivery = deliveryOf(firstAssignment[0]);
  report.routing = {
    owner: routed[0]?.ownerAgentId ?? null,
    deliveryAgentId: firstDelivery?.delivery.recipientAgentId ?? null,
    deliveryStatus: firstDelivery?.delivery.status ?? null,
  };
  assert.equal(report.routing.deliveryAgentId, ROUTED_TO);
  assert.equal(report.routing.deliveryStatus, "queued");
  report.checks.push("A task without an owner is routed by the provider and delivered to its member.");

  // 2. Archive stops the open task and refuses a new one.
  const archived: Channel = await command({
    type: "archive",
    operationId: crypto.randomUUID(),
    channelId,
  });
  assert.equal(archived.archived, true, "The archive did not archive the channel.");
  const tasksBefore = tasks().length;
  let refusal: string | null = null;
  try {
    await command({
      type: "send",
      operationId: crypto.randomUUID(),
      channelId,
      text: "This request must be refused.",
      recipientAgentId: null,
      replyToMessageId: null,
      attachmentDraftIds: [],
    });
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  const stoppedByArchive = await until("the archive stops the open task", tasks, (list) => list[0]?.state === "paused");
  const archivedAssignment = await until("the archive ends the open assignment", assignments, (list) => {
    const assignment = list.find((item) => item.taskId === stoppedByArchive[0]?.id);
    return assignment?.state === "interrupted";
  });
  report.archive = {
    archived: archived.archived,
    refusal,
    newTask: tasks().length > tasksBefore,
    taskState: stoppedByArchive[0]?.state ?? "missing",
    assignmentState: archivedAssignment.find((item) => item.taskId === stoppedByArchive[0]?.id)?.state ?? "missing",
  };
  assert.equal(refusal, sourceText("error.backend.channelArchived"), "The archive did not refuse a new task.");
  assert.equal(report.archive.newTask, false, "The archived channel took a new task.");
  assert.equal(report.archive.taskState, "paused", "The archive did not stop the open task.");
  assert.equal(report.archive.assignmentState, "interrupted", "The archive left the assignment of the task alive.");
  report.checks.push("An archived channel refuses a new task and stops the task that runs.");

  // 3. Restore opens the channel again, and a task runs.
  const restored: Channel = await command({
    type: "restore",
    operationId: crypto.randomUUID(),
    channelId,
  });
  assert.equal(restored.archived, false, "The restore did not open the channel.");
  await command({
    type: "send",
    operationId: crypto.randomUUID(),
    channelId,
    text: "This task must run again.",
    recipientAgentId: ROUTED_TO,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const runningTask = await until("the restored channel runs a task", tasks, (list) => list.length === 2);
  const restoredAssignment = await until(
    "the restored task has an assignment",
    activeAssignments,
    (list) => list.length === 1,
  );
  const restoredDelivery = deliveryOf(restoredAssignment[0]);
  report.restore = {
    archived: restored.archived,
    deliveryAgentId: restoredDelivery?.delivery.recipientAgentId ?? null,
    deliveryStatus: restoredDelivery?.delivery.status ?? null,
  };
  assert.equal(report.restore.deliveryAgentId, ROUTED_TO);
  assert.equal(report.restore.deliveryStatus, "queued");
  report.checks.push("A restored channel takes a task again and delivers it to its member.");

  // 4. Stop ends the turn of a task that runs, and Resume starts it again.
  const stoppedTask = runningTask[1];
  assert.ok(stoppedTask, "The restored channel has no second task.");
  const stopDeliveryId = restoredAssignment[0]?.deliveryId;
  assert.ok(stopDeliveryId, "The task of the restored channel has no delivery.");
  const turnId = `turn-${crypto.randomUUID()}`;
  const threadId = channels.store.context(channelId, ROUTED_TO).threadId;
  await runCauseEffect(mailbox.markStarting(stopDeliveryId));
  await runCauseEffect(mailbox.markRunning(stopDeliveryId, turnId));
  await runCauseEffect(channels.accepted(stopDeliveryId, `session-${crypto.randomUUID()}`, turnId));
  await until("the task runs", tasks, (list) =>
    list.some((item) => item.id === stoppedTask.id && item.state === "running"),
  );
  await command({
    type: "stop",
    operationId: crypto.randomUUID(),
    channelId,
    taskId: stoppedTask.id,
    recipientAgentId: null,
  });
  const paused = await until("the stopped task is paused", tasks, (list) =>
    list.some((item) => item.id === stoppedTask.id && item.state === "paused"),
  );
  // The provider ends the turn that the stop interrupted.
  channels.event({ type: "turn-completed", agentId: ROUTED_TO, threadId, turnId, status: "interrupted" });
  await runCauseEffect(mailbox.markTerminal(stopDeliveryId, "interrupted"));
  const stoppedAssignment = await until("the stopped assignment ends", assignments, (list) => {
    const assignment = list.find((item) => item.taskId === stoppedTask.id);
    return assignment?.state === "interrupted";
  });
  report.stop = {
    taskState: paused.find((item) => item.id === stoppedTask.id)?.state ?? "missing",
    assignmentState: stoppedAssignment.find((item) => item.taskId === stoppedTask.id)?.state ?? "missing",
    interruptedTurnId: interrupts.at(-1)?.turnId ?? null,
    interruptedAgentId: interrupts.at(-1)?.agentId ?? null,
    interruptedThreadId: interrupts.at(-1)?.threadId ?? null,
  };
  assert.equal(report.stop.taskState, "paused", "Stop did not pause the task.");
  assert.equal(report.stop.assignmentState, "interrupted", "Stop did not end the assignment.");
  assert.equal(report.stop.interruptedTurnId, turnId, "Stop did not interrupt the turn of the task.");
  assert.equal(report.stop.interruptedAgentId, ROUTED_TO, "Stop interrupted another agent.");
  assert.equal(report.stop.interruptedThreadId, threadId, "Stop interrupted another thread.");
  report.checks.push("Stop pauses the task, interrupts its turn and ends its assignment.");

  await command({
    type: "resume",
    operationId: crypto.randomUUID(),
    channelId,
    taskId: stoppedTask.id,
    recipientAgentId: null,
  });
  const resumed = await until("the resumed task runs again", tasks, (list) => {
    const task = list.find((item) => item.id === stoppedTask.id);
    return task?.state === "queued" || task?.state === "running";
  });
  const resumedAssignment = await until("the resumed task has an assignment", activeAssignments, (list) =>
    list.some((item) => item.taskId === stoppedTask.id),
  );
  const resumedDelivery = deliveryOf(resumedAssignment.find((item) => item.taskId === stoppedTask.id));
  assert.ok(resumedDelivery, "The resumed task has no delivery.");
  report.resume = {
    taskState: resumed.find((item) => item.id === stoppedTask.id)?.state ?? "missing",
    deliveryAgentId: resumedDelivery?.delivery.recipientAgentId ?? null,
    deliveryStatus: resumedDelivery?.delivery.status ?? null,
    newDelivery: resumedDelivery?.delivery.id !== stopDeliveryId,
  };
  assert.equal(report.resume.deliveryAgentId, ROUTED_TO, "Resume delivered the task to another agent.");
  assert.equal(report.resume.deliveryStatus, "queued", "Resume did not deliver the task again.");
  assert.equal(report.resume.newDelivery, true, "Resume reused the delivery of the stopped turn.");
  report.checks.push("Resume queues the stopped task again and delivers it to the same member.");

  // 5. Reassign moves one task and keeps the rest.
  await command({
    type: "send",
    operationId: crypto.randomUUID(),
    channelId,
    text: "This task belongs to the second member.",
    recipientAgentId: SECOND,
    replyToMessageId: null,
    attachmentDraftIds: [],
  });
  const keptTask = (
    await until("the second task has an owner", tasks, (list) =>
      list.some((item) => item.instruction.includes("belongs to the second member") && item.ownerAgentId === SECOND),
    )
  ).find((item) => item.instruction.includes("belongs to the second member"));
  assert.ok(keptTask, "The second task has no owner.");
  const keptAssignmentBefore = (
    await until("the second task has an assignment", activeAssignments, (list) =>
      list.some((item) => item.taskId === keptTask.id),
    )
  ).find((item) => item.taskId === keptTask.id);
  assert.ok(keptAssignmentBefore, "The second task has no assignment.");
  await command({
    type: "reassign",
    operationId: crypto.randomUUID(),
    channelId,
    taskId: stoppedTask.id,
    recipientAgentId: THIRD,
  });
  const reassigned = await until("the reassigned task has the new owner", tasks, (list) =>
    list.some((item) => item.id === stoppedTask.id && item.ownerAgentId === THIRD),
  );
  const keptAssignmentAfter = latestAssignment(keptTask.id);
  report.reassign = {
    movedOwner: reassigned.find((item) => item.id === stoppedTask.id)?.ownerAgentId ?? null,
    keptOwner: reassigned.find((item) => item.id === keptTask.id)?.ownerAgentId ?? null,
    keptAssignmentAgentId: keptAssignmentAfter?.agentId ?? null,
    keptAssignmentState: keptAssignmentAfter?.state ?? "missing",
  };
  assert.equal(report.reassign.movedOwner, THIRD, "The reassign did not move the task.");
  assert.equal(report.reassign.keptOwner, SECOND, "The reassign moved the other task too.");
  assert.equal(report.reassign.keptAssignmentAgentId, keptAssignmentBefore.agentId);
  assert.equal(report.reassign.keptAssignmentState, keptAssignmentBefore.state);
  report.checks.push("Reassign moves one task to another member and keeps the other task and its run.");

  assert.deepEqual(report.errors, [], "The channel service reported an error.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await rm(root, { recursive: true, force: true });
  writeReport("channel-service-e2e", report);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
