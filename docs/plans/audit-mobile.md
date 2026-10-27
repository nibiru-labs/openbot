# Mobile chat audit

Audit date: 2026-10-27.

This document compares the chat features of the desktop app (`src/renderer`, `packages/ui`) with the
chat features of the iPhone app (`apps/mobile`). It lists the gaps that a user of the phone can see.
It does not list features that only the local computer can have, because the wire protocol does not
carry them.

Every path is relative to the repository root.

## Method

1. I read the desktop chat: `src/renderer/src/features/conversation`,
   `src/renderer/src/features/channels`, `src/renderer/src/features/files`,
   `src/renderer/src/app-message-projection.ts` and `packages/ui/src/features/conversation`.
2. I read the mobile chat: `apps/mobile/src/features/chat`, `apps/mobile/src/features/channels`,
   `apps/mobile/src/features/agents` and `apps/mobile/src/features/workspace`.
3. I compared the two apps against the wire contract in `packages/contracts/src/team-protocol`. A
   feature that the Team protocol carries is a gap in the phone app. A feature that the protocol does
   not carry is an intended difference, and it is in the last section of this document.
4. I checked each finding in the source. A finding without a source line is not in this document.

## Summary

Size means the work: S is a small change in one file, M is a change in a few files, L is a new
feature with several files.

| # | Finding | User impact | Size |
| --- | --- | --- | --- |
| 1 | An MCP sign-in cannot start on the phone | High | M |
| 2 | The side question has no phone screen | High | M |
| 3 | The system markers of a turn do not show | High | S |
| 4 | The Marketplace suggestion card does not show | Medium | S |
| 5 | The composer draft is lost when the app stops | High | M |
| 6 | Team members cannot write to each other on the phone | High | L |
| 7 | The file list of one chat has no phone screen | Medium | M |
| 8 | A reply quote cannot open the original message | Medium | S |
| 9 | A routine schedule cannot change in the chat | Medium | M |
| 10 | The chat has no day separator | Medium | S |
| 11 | There is no search inside one chat | Medium | M |
| 12 | The chat has no unread divider and no message count | Medium | M |
| 13 | Copy takes the text only | Medium | S |
| 14 | The error banner of the composer has no detail | Medium | S |
| 15 | A thread cannot be renamed or deleted on the phone | Low | M |

## Findings

### 1. An MCP sign-in cannot start on the phone

The desktop shows a card in the chat when an agent saves an MCP server that needs a sign-in. The
person signs in from that card, then tells the agent to test the server again.

The phone cannot start any MCP sign-in. Its own code says so.

Desktop:

- `src/renderer/src/features/conversation/ConversationTimeline.tsx:845` draws the card.
- `packages/ui/src/features/conversation/McpSignInCard.tsx:29` holds the sign-in and continue actions.
- `src/renderer/src/features/conversation/McpSignInChatCard.tsx:18` sends the continue message.

Mobile:

- `apps/mobile/src/features/servers/screens/server-mcp-server-screen.tsx:33` says: "This phone
  cannot sign in to an MCP server yet." The screen only shows the error.
- `apps/mobile/src/features/servers/model/use-server-mcp.ts:44` reads the sign-in state of the host,
  so the phone knows that a sign-in is open. It cannot finish it.

Impact: a turn that waits for an MCP sign-in stays blocked on the phone. The user must go to the
computer.

Fix: add the sign-in action to the mobile MCP server screen, and show the card in the mobile chat
when the host sends an `mcp-sign-in` message. The host route set `mcp-sign-in-v1` already exists in
`packages/contracts/src/team-protocol/mcp-sign-in-v1.ts`.

Size: M.

### 2. The side question has no phone screen

The desktop can ask a question about the chat without touching the agent. The agent answers with its
own model, with no tools. Nothing of the exchange is kept. The host route set `side-question-v1`
carries this feature over the wire.

Desktop:

- `src/renderer/src/features/conversation/ConversationComposer.tsx:823` puts the action in the
  composer menu.
- `src/renderer/src/features/conversation/ConversationPanels.tsx:316` shows the panel.
- `src/renderer/src/features/conversation/stores/side-question-store.ts:76` asks the question and
  keeps the answer.
- `packages/contracts/src/team-protocol/side-question-v1.ts:14` names the capability.

Mobile: no file under `apps/mobile/src` uses the capability, the route, or the panel.

Impact: the phone user has no way to ask a question about a chat that does not change the agent.

Fix: add a route that calls `SIDE_QUESTION_ROUTES.ask`, and add the panel to the mobile chat. Gate it
on the `side-question-v1` capability, as the desktop does.

Size: M.

### 3. The system markers of a turn do not show

The desktop turns a system message into a marker row. The rows name a model change, a pause, a
channel change, a vault change, a hosted site, and a skill change. The desktop builds the marker from
the stored message.

The phone drops every system message. The phone keeps only routine, new chat and dispatch markers.

Desktop:

- `src/renderer/src/app-message-projection.ts:310` builds the marker.
- `src/renderer/src/app-message-projection.ts:340` builds the agent pause marker.
- `src/renderer/src/app-message-projection.ts:351` builds the model switch marker.

Mobile:

- `apps/mobile/src/features/chat/model/chat-messages.ts:381` skips every message whose author is
  `system`.
- `apps/mobile/src/features/chat/model/chat-messages.ts:330` keeps only the routine marker.

Impact: the phone user sees no sign that the agent changed its model, that a turn stopped for a
token limit, or that a member agent changed the channel. The chat looks as if nothing happened.

Fix: read the stored system message in the mobile projection and draw a marker row for each kind
that the host sent. The item type and the text of the message are in the wire shape, so no protocol
change is needed.

Size: S.

### 4. The Marketplace suggestion card does not show

The desktop shows a card in the chat when an agent suggests a Marketplace app. The person connects the
app from that card.

The phone has the Marketplace screens, but the chat never shows the suggestion. The suggestion is a
stored system message, and finding 3 drops it.

Desktop:

- `src/renderer/src/features/conversation/ConversationTimeline.tsx:860` draws the card.
- `packages/contracts/src/marketplace-suggestion-events.ts:25` reads the suggestion from the message.

Mobile: `apps/mobile/src/features/chat/model/chat-messages.ts:381` drops the message. The phone has
the connect screen at
`apps/mobile/src/features/marketplace/screens/marketplace-app-connect-screen.tsx`.

Impact: the phone user does not learn that the agent asked for an app. The agent waits for a person
that never comes.

Fix: draw the suggestion card in the mobile chat and send the person to the existing connect screen.

Size: S.

### 5. The composer draft is lost when the app stops

The desktop keeps the text of the composer for each chat. It restores that text when the app starts
again. It also puts back the text of a message that was not sent.

The phone keeps no draft. Its own code says so.

Desktop:

- `src/renderer/src/features/conversation/composer-draft-storage.ts:36` reads the stored drafts.
- `src/renderer/src/features/conversation/composer-draft-storage.ts:56` writes them after each change.
- `src/renderer/src/app-providers.tsx:98` reads them at start-up.

Mobile:

- `apps/mobile/src/features/chat/components/chat-view.tsx:737` says: "The composer draft is not
  saved."
- The outbox keeps a message that was sent but not confirmed, in
  `apps/mobile/src/features/chat/model/outbox-store.ts:152`. That is a different thing.

Impact: the phone user loses a long message when the system closes the app, or when the app stops
after a crash. The desktop keeps it.

Fix: store the draft of each chat in the phone's own storage, keyed by server and agent, and restore
it when the chat opens. The phone already writes files of its own with
`apps/mobile/src/features/chat/model/outbox-files.ts:12`.

Size: M.

### 6. Team members cannot write to each other on the phone

The desktop lets the members of a team write to each other. Each member has a thread list, a
conversation, a typing sign, and an unread count.

The phone has none of this. The host serves the feature under the `direct-messages` capability, and
the desktop uses it.

Desktop:

- `src/renderer/src/features/conversation/direct-messages-context.tsx:94` owns the thread list, the
  pages, the read state, and the typing sign.
- `src/renderer/src/features/conversation/WorkspaceDirectConversation.tsx:11` draws the conversation.
- `src/main/team-api-server.ts:1478` serves the routes to a client that asks for the capability.

Mobile: no route, screen, or store under `apps/mobile/src` reads or writes a direct message.

Impact: a phone user cannot take part in a person-to-person conversation of the team. The desktop
user can.

Fix: add the thread list, the conversation, and the send action to the mobile app. The routes and the
events already exist in the wire contract.

Size: L.

### 7. The file list of one chat has no phone screen

The desktop shows a Files panel next to a chat. The panel lists every file of that one chat. A row
can show the file in the chat, and an owner can delete a file.

The phone asks the host for the files of an agent and the files of the whole host. It never asks for
the files of one chat.

Desktop:

- `src/renderer/src/features/conversation/ConversationPanels.tsx:299` opens the panel.
- `src/renderer/src/features/files/ChatFilesPanel.tsx:18` asks for the files of one chat.
- `packages/ui/src/features/files/ConversationFilesPanel.tsx:33` draws the list and the "Show in
  chat" action.

Mobile:

- `apps/mobile/src/features/workspace/context/host-request-actions.ts:722` asks for the scope
  `agent`.
- `apps/mobile/src/features/workspace/context/host-request-actions.ts:730` asks for the scope `host`.
- `apps/mobile/src/features/agents/components/agent-files.tsx:41` lists the chats by size, but a row
  does not open the files of that chat.

The wire contract has the scope that the desktop uses:
`packages/contracts/src/team-protocol/storage-v1.ts:111`.

Impact: a phone user cannot see which files belong to one chat, and cannot delete one file of one
chat. The desktop user can.

Fix: add a chat storage request with the scope `conversation` and a screen that shows the list. The
phone can reuse the file preview that it already has.

Size: M.

### 8. A reply quote cannot open the original message

The desktop draws the quote of a reply as a button. A tap scrolls to the original message, marks it,
and offers a way back to the reply.

The phone draws the quote as text. It cannot be pressed.

Desktop:

- `packages/ui/src/features/conversation/MessageRendering.tsx:521` draws the button.
- `src/renderer/src/features/conversation/stores/reply-jump-store.ts:173` scrolls to the message and
  marks it.

Mobile:

- `apps/mobile/src/features/chat/components/chat-message-list.tsx:722` draws the quote as a label.

Impact: a phone user cannot follow a reply back to the message that it answers. The desktop user can.

Fix: make the quote a press control in the mobile chat. Use the row index of the message, or the
window around a message that the chat already loads.

Size: S.

### 9. A routine schedule cannot change in the chat

The desktop shows a card in the chat when an agent makes a routine. The card names the routine and
its next run. The person can change the schedule there, and the change saves at once.

The phone shows one line of text with the name of the routine. There is no card and no action.

Desktop:

- `src/renderer/src/features/conversation/RoutineChatCard.tsx:40` holds the card and the save.
- `src/renderer/src/features/conversation/ConversationTimeline.tsx:794` puts the card in the timeline.

Mobile:

- `apps/mobile/src/features/chat/components/chat-message-list.tsx:363` draws the routine marker row.
- The phone can already save a routine:
  `apps/mobile/src/features/workspace/context/host-request-actions.ts:568`.

Impact: a phone user must open the routine screen to change a schedule. The desktop user can do it in
the chat.

Fix: draw the routine card in the mobile chat and save the schedule with the routine save request that
the phone already has.

Size: M.

### 10. The chat has no day separator

The desktop draws a line between the messages when the day changes. The line names the day and the
time. A message of an older day also shows its date under the bubble.

The phone draws the time only. It never shows the date.

Desktop:

- `packages/ui/src/features/conversation/chat-day-markers.ts:46` gives the label of the separator.
- `src/renderer/src/features/conversation/ConversationTimeline.tsx:770` draws the separator.
- `packages/ui/src/features/conversation/chat-timestamp.ts:5` gives the date of an older message.

Mobile:

- `apps/mobile/src/features/chat/components/chat-message-actions.tsx:125` shows the time only.
- No file under `apps/mobile/src/features/chat` uses the day marker.

Impact: a phone user cannot tell when an older message was written. A long chat has no time order.

Fix: port the day marker rule to the mobile chat and draw a separator row. The mobile message list
already sorts the messages by time.

Size: S.

### 11. There is no search inside one chat

The desktop has a search bar in the chat. It marks every match, and it moves to the next match and
the match before. For a joined server it also asks the host for the matches.

The phone has a search in the home screen only. It finds a message across all agents and opens the
chat at that message. It cannot search inside one chat and it cannot step through the matches.

Desktop:

- `packages/ui/src/features/conversation/ChatSearch.tsx:15` holds the search bar.
- `src/renderer/src/features/conversation/ConversationTimeline.tsx:557` shows it.
- `src/renderer/src/features/conversation/stores/search-store.ts:24` reads the matches.

Mobile:

- `apps/mobile/src/features/search/model/mobile-search.ts:170` builds the global search.
- `apps/mobile/src/features/search/components/search-result-row.tsx:224` opens the chat at the
  message.

Impact: a phone user with a long chat must leave the chat and search the whole workspace to find one
message.

Fix: add a search bar to the mobile chat that filters the loaded messages and asks the host for the
matches when the chat has more pages than the phone holds.

Size: M.

### 12. The chat has no unread divider and no message count

The desktop shows a line in the chat where the unread messages start. It shows a banner with the
number of new messages, a button that jumps to them, and a button that marks them read.

The phone marks the chat read when it is at the newest message. It shows no line and no count.

Desktop:

- `packages/ui/src/features/conversation/UnreadMessages.tsx:5` holds the banner.
- `packages/ui/src/features/conversation/UnreadMessages.tsx:40` holds the divider.
- `src/renderer/src/features/conversation/ConversationTimeline.tsx:570` shows the banner.

Mobile:

- `apps/mobile/src/features/chat/components/chat-view.tsx:577` marks the chat read.
- No file under `apps/mobile/src/features/chat` draws an unread line or a count.

Impact: a phone user who scrolls up in a chat cannot see where the new messages start. The desktop
user can.

Fix: keep the read cursor of the chat in the mobile store, draw the divider above the first unread
message, and add a banner with a jump action.

Size: M.

### 13. Copy takes the text only

The desktop copies a message and its files. The files stay in the clipboard of the app, so a paste
into the composer brings the files with the text.

The phone copies the text only.

Desktop:

- `src/renderer/src/features/conversation/composer-clipboard.ts:128` copies the message with its
  files.
- `src/renderer/src/features/conversation/stores/message-actions.ts:103` calls it.

Mobile:

- `apps/mobile/src/features/chat/components/use-copy-message.ts:15` calls
  `Clipboard.setStringAsync` with the text only.

Impact: a phone user cannot move the files of a message to another chat. The desktop user can.

Fix: keep the copied files in the phone's outbox storage, and paste them with the text.

Size: S.

### 14. The error banner of the composer has no detail

The desktop shows a banner above the composer when a turn fails. The banner names the provider and
the model. It shows the code of the failure. The person can close it. Some errors have an action,
such as the update of a key.

The phone shows one line of red text. It has no title, no code, and no close action.

Desktop:

- `packages/ui/src/features/conversation/ComposerErrorBanner.tsx:17` holds the banner.
- `src/renderer/src/features/conversation/ConversationComposer.tsx:600` shows it.

Mobile:

- `apps/mobile/src/features/chat/components/chat-view.tsx:1040` shows a plain paragraph.

Impact: a phone user cannot tell which model failed, cannot give the code to support, and cannot
close the message.

Fix: use the notice component of the phone app for the failure, and add the provider, the model, the
reference code, and a close action.

Size: S.

### 15. A thread cannot be renamed or deleted on the phone

The desktop chat shows the threads of an agent as tabs. The person can rename a thread and can delete
a thread for good. The host route set `agent-threads-v1` carries this feature over the wire.

The phone shows the tasks of an agent. It can stop, close and reopen a task. It cannot rename a task
and it cannot delete one.

Desktop:

- `packages/ui/src/features/conversation/threads/ThreadTabs.tsx:410` renames a thread.
- `packages/ui/src/features/conversation/threads/ThreadTabs.tsx:537` deletes a thread.

Mobile:

- `packages/team-client/src/team-api-requests.ts:231` has the rename request.
- `packages/team-client/src/team-api-requests.ts:241` has the delete request.
- No file under `apps/mobile/src` calls either request. The mobile task screen calls only
  `controlAgentTask`, in
  `apps/mobile/src/features/servers/screens/agent-task-screen.tsx:280`.

Impact: a phone user cannot clean up the tasks of an agent. The desktop user can.

Fix: add a rename and a delete action to the mobile task screen, and call the two requests that the
team client already has. Gate them on the `agent-threads-v1` capability.

Size: M.

## Intended differences

The features below are on the desktop only. The wire protocol does not carry them, so the phone cannot
show them. They are not gaps in the phone app. A phone app can add them only after a change to the
protocol.

- **The context meter and the Compact action.** The context state is local to the computer.
  `packages/contracts/src/ipc-agent-runtime.ts:157` says so. The Team protocol drops it in
  `packages/contracts/src/team-protocol/provider-aware-codec.ts:1869`.
- **The trace of a turn and the steps of a finished turn.** The trace is local to the computer.
  `packages/contracts/src/ipc-conversation-messages.ts:239` says so. The plan and the checklist of the
  tasks reach the phone as text, and the phone reads the plan from the text, as the desktop does.
  `apps/mobile/src/features/chat/model/chat-messages.ts:243`.
- **The citations of a message.** The Team protocol drops the field. The desktop shows them only for a
  local chat.
- **The waits of an agent.** The `waits-changed` event is a desktop event only. It is not in the Team
  event list, `packages/contracts/src/team-protocol/provider-aware-codec.ts:162`.
- **The voice conversation and the read-aloud bar.** They use the audio of the computer. The desktop
  keeps them for a local chat only, `src/renderer/src/features/conversation/conversation-scope.ts:1626`.
  The phone has its own dictation, which is the phone form of the same work.
- **The workspace files and the reveal in the file manager.** They belong to the computer.

## Claims I could not confirm

- I did not run the desktop app or the phone app. Every finding comes from the source. The size of
  each fix is an estimate from the code, not from a test.
- I did not check the public web client in `src/renderer/src/features/web-client`. The audit compares
  the desktop app and the phone app only.
- I did not read the support log review and the earlier mobile draft. They are not in this repository.
  This document does not repeat their findings.
- The chat of the web client shares much of the code of the desktop chat. Some findings may also
  apply to it. I did not check this.
