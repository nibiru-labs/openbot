### Added

- An end-to-end check of the 1Password connection and the GitHub connection of the desktop app. The
  check runs a fake 1Password command line program and a fake GitHub server on this computer, so
  it needs no account and no network. It holds that the connection file of 1Password holds no
  secret in clear and that only the user can read it, that the 1Password command line program
  runs as the user and never receives the token, that the GitHub sign-in, the token refresh and
  the bot token of a repository work, that the git helper gives the bot token of the repository
  and the user token everywhere else, and that no secret reaches a log line or the report of the
  check.
