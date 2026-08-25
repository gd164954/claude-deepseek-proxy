# Changelog

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
