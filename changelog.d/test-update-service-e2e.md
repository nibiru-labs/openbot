### Added

- An end-to-end check of the desktop update service against a local feed. It holds that a check with
  no update stays up to date, a check with an update is offered, a failed download and a cancelled
  download report an error, a successful download is ready to restart, and a restart when idle waits
  for work before it requests install.
