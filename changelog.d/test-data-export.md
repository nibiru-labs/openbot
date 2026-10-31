### Added

- An end-to-end check of the local data export. It holds that the archive holds the manifest of
  the backup with its schema version, the agent list without the workspace of an agent, the
  memories, the conversations and the queues, and the attachment file with its bytes. It holds that
  no exported file names a secret of the profile, such as an agent API key, the header of an MCP
  server, the key of a custom provider, the environment value of a custom agent, a browser cookie or
  a file of the workspace of an agent, and that the diagnostics report of the same profile holds no
  conversation text, no file path, no token and no raw error message.
