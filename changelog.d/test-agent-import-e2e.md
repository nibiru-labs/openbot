### Added

- An end-to-end check of the import of a Grok Bot export. It holds that the imported agents, their
  routines, their memories and the group chat of the export are rows of the profile, that the skill
  of the export is a published revision that is installed in the workspace of the agent, that the
  workspace files of the export are copied under `imported/`, that an archive with an unsafe path is
  refused, that an export nobody applies twice creates no second agent, and that the `bots.json`
  file of an install before the move to SQLite is imported once.
