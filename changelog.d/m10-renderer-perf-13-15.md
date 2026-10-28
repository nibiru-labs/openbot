### Fixed

- The desktop conversation reuses memoized mention agents, message references, and an own-sender
  callback so timeline rows do not rebuild on every prop read.
- The composer editor compares attachment, skill, and MCP lists by reference instead of rebuilding
  joined keys on every keystroke.
- Chat message rows and action markers look up agents through a map built once per agent list.
