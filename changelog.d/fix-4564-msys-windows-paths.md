### Fixed

- Accept a Windows path that a Unix-style shell wrote as `/c/Users/...` when an agent attaches a file. Before, the path resolved to `<drive>:\c\Users\...`, so the file was rejected as outside the agent workspace.
