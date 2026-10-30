### Fixed

- Team API admin routes no longer send raw internal failure text to released clients. Catalog
  refusals still reach the client; other failures answer with "Request failed." and stay in the log.
