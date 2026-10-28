### Fixed

- Attach smooth height resize observers only while height animation is active, and skip layout reads when animation is off.
- Build citation and attachment lookup maps once per markdown message instead of once per text paragraph.
