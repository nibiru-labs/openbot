### Added

- An end-to-end check of the agent profile tools. It creates an agent with `create_agent`, reads the
  profile back with `read_agent`, edits it with `update_profile`, and holds that the profile is
  still there after the agent store restarts. A request for an agent that does not exist, a request
  that widens what an agent may do, and a profile with an invalid avatar hue are refused, and a
  refused request changes nothing.
