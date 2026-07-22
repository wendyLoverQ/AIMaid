# AIMaid Desktop ↔ Core protocol 1.0

The only production transport is UTF-8 JSON Lines over the Core process standard input/output. Each line is one
complete envelope. Core stdout is reserved for protocol messages; diagnostics are written to stderr.

The language-neutral files in this directory are authoritative. Changes must update the schemas/catalogs, C# DTOs,
TypeScript types, validators, and tests together.

Binary payloads are prohibited. Messages may carry IDs, metadata, sizes, MIME types and validated file paths only.

Handshake is mandatory before all requests except `system.handshake`. The current validation surface is:

- `system.health`: real Core process and SQLite readiness information.
- `settings.get`: real read-only query through `SettingsApplicationService` and `SqliteCoreStore`.
- `system.stream`: cancellable ordered event stream ending in `system.stream.completed` or `request.cancelled`.
- `system.shutdown`: graceful protocol shutdown used by Electron `before-quit`.
