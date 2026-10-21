### Added

- Token limits for each agent, in Settings: 15M tokens per hour and 5M tokens per turn by default.
  0 means no limit. At the hourly limit, an agent starts no new work until you press Continue in its
  chat. The work that runs goes on.
- A turn that goes past the turn limit stops after its current step. Its work, plan and session are
  kept. Continue starts a short turn that carries on from there.

### Changed

- A turn that the provider plan refuses after it did work now ends as stopped, not failed. The agent
  carries on by itself when the plan limit ends.
