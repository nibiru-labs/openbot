### Fixed

- Align the database migration tests with schema version 45. The routine backoff migration added
  version 45, but the migration tests were still written against version 44 as the latest: they
  expected a fully upgraded database to stop at version 44, fixtures that delete migration markers
  above a target version left the version 45 marker in place, the newer-than-supported guard
  fixtures used 45 as the future version, and the whole-database comparisons did not expect the new
  empty routine backoff table. The tests now expect version 45, use 46 as the future version, and
  expect the empty routine backoff table after a full upgrade. No migration, schema definition, or
  user-visible behavior changes.
