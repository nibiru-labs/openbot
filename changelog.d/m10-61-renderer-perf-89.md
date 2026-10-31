### Fixed

- Store conversation drafts, errors, and right-panel modes per key instead of spreading whole keyed records on every write.
- Store per-agent turn rows in one table and load agent queues on demand instead of prefetching every agent on each list change.
