### Added

- An end-to-end check of the download of a provider runtime. It holds that a download whose bytes do
  not match the hash the lock names is refused and leaves nothing behind, that a good archive is
  unpacked, checked and installed, that the new runtime is handed to the agent service, that a CLI
  the user pointed OpenBot at is left alone, and that an update installs the newer version.
