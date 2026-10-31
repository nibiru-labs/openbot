/**
 * "Stop and send": the text of the composer stops the running turn and goes next, as the desktop
 * does it in one step. The phone has no route that stops a turn and sends a message at once, so it
 * uses the two routes it has: it stops the turn and then sends the message.
 */

/** What the chat knows about the turn and the composer when it offers the action. */
export interface StopAndSendInput {
  /** A turn runs in this chat. */
  running: boolean;
  /** The composer holds something to send. */
  hasDraft: boolean;
  /** The chat cannot send now: the composer is disabled or a send waits. */
  disabled: boolean;
}

/**
 * The action shows while a turn runs and the composer holds a message: the person wants to stop the
 * work and send instead of waiting for it. Without a turn there is nothing to stop, and without a
 * message there is nothing to send.
 */
export function canStopAndSend(input: StopAndSendInput): boolean {
  return input.running && input.hasDraft && !input.disabled;
}

/**
 * Stops the turn and sends the message. The stop comes first, so the message runs after the old
 * turn has stopped. A stop that fails sends nothing: the person keeps the text and reads the error.
 */
export async function stopAndSend(input: {
  stop: () => Promise<void>;
  send: (text: string) => void;
  text: string;
}): Promise<void> {
  await input.stop();
  input.send(input.text);
}
