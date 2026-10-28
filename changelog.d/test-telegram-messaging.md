### Added

- An end-to-end check of the Telegram connection. A chat links with a one-use code, a mention and a
  reply in a chain reach the Telegram Orchestrator, a direct chat and a forum topic get their own
  conversation, the answer goes back to the same chat and the same thread, a file that arrives is
  given to the agent, and a file over the 20 MB limit is refused. The check talks to a fake Bot API
  on the computer, so it needs no token and no network.
