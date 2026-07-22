# Electron ↔ C# Core protocol

## Transport and lifecycle

The production transport is UTF-8 JSON Lines over one child process stdin/stdout pair. Electron Main is the only
process owner. Core stdout is protocol-only; diagnostics go to stderr.

```text
Electron ready → spawn Core → system.handshake → Ready → enable Core requests
before-quit → system.shutdown → wait → terminate on timeout → remove listeners
```

Development launches `dotnet src/AIMaid.CoreHost/bin/Debug/net8.0/AIMaid.CoreHost.dll`. Packaging publishes a
self-contained executable under `apps/desktop/resources/core/<platform>-<arch>` and copies it to the same path under
Electron resources.

## Envelope

Every request, response and event contains `protocolVersion`, `id`, `kind`, `type`, `timestamp` and `payload`.
Responses add `success` and `error`; events add `correlationId` and monotonically increasing `sequence`.
The authoritative schema and catalogs are in [`../contracts`](../contracts/README.md).

## Current messages

| Type | Kind | Purpose |
|---|---|---|
| `system.handshake` | query | Validate protocol/version/platform and return Core capabilities. |
| `system.health` | query | Return real process readiness, version, PID and uptime. |
| `settings.get` | query | Read non-sensitive keys through the real settings service and SQLite store. |
| `system.stream` | command | Start a cancellable ordered validation stream. |
| `system.cancel` | command | Cancel an active Core request by ID. |
| `system.shutdown` | command | Request graceful process termination. |
| `core.ready` | event | Announce successful handshake. |
| `system.stream.progress` | event | Ordered non-terminal progress. |
| `system.stream.completed` | event | Explicit successful terminal event. |
| `request.cancelled` | event | Explicit cancellation terminal event. |
| `system.protocol.error` | event | Report malformed input that cannot be correlated to a valid request. |

## Error codes

Protocol errors use `PROTOCOL_INVALID_JSON`, `PROTOCOL_INVALID_ENVELOPE`, `PROTOCOL_VERSION_MISMATCH`,
`PROTOCOL_UNKNOWN_TYPE` and `PROTOCOL_DUPLICATE_REQUEST`. Lifecycle/client errors use `CORE_NOT_READY`,
`CORE_START_FAILED`, `CORE_EXITED`, `REQUEST_TIMEOUT` and `REQUEST_CANCELLED`. Validation and execution use
`INVALID_ARGUMENT`, `CAPABILITY_UNSUPPORTED` and `INTERNAL_ERROR`.

Error responses never include a Core stack, credentials or arbitrary local paths. Detailed exceptions remain in stderr
or the Main log.

## Adding a message

Update the root contract catalog/schema, C# Host DTO/dispatcher, TypeScript types/validator, IPC allow-list and tests in
the same change. Do not add a second transport or expose executable paths/channels to Renderer code. Binary content
must use a dedicated file/service channel; JSON Lines carries only IDs, paths and metadata.
