### Fixed

- Reuse timeline rows and the id index map when the message list is unchanged, so streaming updates do not rerun every grouping pass.
- Virtualize agent chats above twenty messages instead of one hundred.
- Cache parsed message content blocks in a two-hundred-entry LRU so scrolling remounts do not reparse every body.
