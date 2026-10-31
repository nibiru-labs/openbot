### Added

- An end-to-end check of a local skill. It publishes a skill from an agent workspace and then a
  second revision, and holds that the first revision stays readable, that a revision with an old
  number is refused, that an install writes the skill into both provider folders of the agent, that
  an installed copy does not follow a new revision, and that a file you changed is never
  overwritten.
