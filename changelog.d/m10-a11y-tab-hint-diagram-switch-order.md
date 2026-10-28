### Fixed

- Expose the browser tab close keyboard hint with `aria-describedby` instead of unsupported
  `aria-description`.
- Use `role="group"` on diagram and preview canvases so screen readers can browse embedded controls
  while arrow-key panning still works when the canvas is focused.
- Match routine active-toggle reading order to its switch-first layout.
