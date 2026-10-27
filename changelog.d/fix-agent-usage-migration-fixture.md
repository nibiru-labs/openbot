### Fixed

- Repair the fixture of the agent usage migration. The fixture stood for a database of version 14 but
  kept the tables that the later migrations created. The reserved schema check rejects such a
  database before the upgrade starts, so the test stopped with the message of that check and not with
  the message of the rollback. The fixture now drops the tables of the later migrations, as the other
  fixtures of the older releases do. The assertions, the migration versions and the user data of the
  fixture stay the same. No migration, schema definition, or user data changes.
