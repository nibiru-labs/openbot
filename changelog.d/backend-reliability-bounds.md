### Added

- An end-to-end check that a provider uses the normal start timeout again after it answers
  `initialize`, that shown configuration warnings stay bounded, and that MCP command lookup cache
  stays bounded.

### Fixed

- A provider that timed out once no longer keeps the long start timeout for every later start.
  OpenBot now forgets the slow start after `initialize` succeeds.
- Shown configuration warnings no longer grow without limit for the life of the app. OpenBot now
  keeps a bounded set and drops the oldest warning when the set is full.
- MCP command lookup no longer keeps one cache entry per command and PATH pair for the life of the
  app. OpenBot now keeps a bounded cache and drops the oldest entry when the cache is full.
