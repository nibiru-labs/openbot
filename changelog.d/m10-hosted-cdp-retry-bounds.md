### Fixed

- A hosted server or server-mode machine stops automatic start retries after five attempts and
  shows the last failure on the host status instead of retrying every ten minutes forever.
- A dead browser CDP capture session is reported on the first failed cleanup command instead of
  leaving the browser panel on a stale empty page.
