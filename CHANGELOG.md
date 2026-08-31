# Changelog

## V1.7.00 - 2026-08-31

- Show an explicit checking state after transient health failures and an unresponsive state after three consecutive failures while the owned proxy process is still alive, in both GUI launchers.
- Preserve stop/restart controls, reset failure counts on recovery and lifecycle changes, and ignore stale asynchronous probe results after stop, exit, or restart.
- Drain native resources on normal shutdown instead of forcing an immediate exit, avoiding a reproduced Windows Node.js assertion after short-lived requests; retain the shutdown timeout fallback.
- Add bounded request/upstream model IDs and client/upstream streaming flags to request start, completion, and failure logs without recording conversation content.
- Cover health-state transitions, metadata, passthrough models, forced non-stream requests, HTTP errors, timeouts, client cancellation, log redaction, immediate shutdown, in-flight stream draining, and listener-error exit with regression tests.
- Retain the v1.6.14 monochrome icon at 93 percent scale and the existing UI layout.

## v1.6.14 - 2026-08-27

- Refine the monochrome eight-segment icon subject scale from approximately 95 percent to exactly 93 percent.
- Increase the even transparent inset to approximately 9 pixels at 256 x 256 while preserving the palette, shape, proportions, and gradient direction.

## v1.6.13 - 2026-08-27

- Reduce the eight-segment icon subject to approximately 95 percent while preserving the 256 x 256 canvas, monochrome palette, proportions, transparency, and gradient direction.
- Add a subtle, even transparent inset so the icon has more visual breathing room in the window, taskbar, tray, and Explorer.

## v1.6.12 - 2026-08-26

- Adopt the selected eight-segment monochrome application icon with a lower-left-light to upper-right-deep grayscale progression.
- Preserve the existing edge-to-edge silhouette, transparent background, inner opening, and small-size icon clarity across the EXE, window, taskbar, and tray surfaces.

## v1.6.11 - 2026-08-26

- Expand the editable model routing panel from two mappings to three with a new Haiku route.
- Persist and validate the Haiku Claude-facing and DeepSeek-facing model IDs in both GUI launchers and the command-line launcher.
- Add `claude-haiku-4-5 -> deepseek-v4-flash` to the default proxy model list.
- Remove the transparent outer padding from the existing eight-segment icon while preserving its 256 x 256 canvas, subject, and approved color direction.

## v1.6.10 - 2026-08-25

- Record proxy version, PID, Node.js version, configured listener, shutdown reason, exit code, and process uptime in runtime logs.
- Gracefully stop the bundled proxy through its private standard-input control channel before using a forced process termination fallback.
- Close local GUI health-check connections explicitly to avoid transient `CLOSE_WAIT` sockets between polling cycles.
- Retain the v1.6.9 request correlation, full streaming duration, lower polling frequency, software rendering, and UI resource reductions.
- Ship a portable Windows x64 ZIP with bundled Node.js, SHA-256 checksums, and no Node.js installation requirement on the target PC.

## v1.6.9 - 2026-08-23

- Add request IDs, upstream time-to-first-byte, full request duration, and distinct client-disconnect logging.
- Reduce long-running GUI CPU, memory, polling, and rendering overhead.
- Verify local health, model listing, authentication, and package integrity after an extended runtime test.
