### Fixed

- A coding dispatch run that never reaches a terminal state no longer keeps a poll loop for the life
  of the app. The watcher now backs off between polls, stops after four hours, and marks the run
  `unknown` so the person can cancel it with dispatch_abort.
