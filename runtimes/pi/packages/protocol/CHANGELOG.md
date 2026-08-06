# Changelog

## [Unreleased]

### Breaking Changes

- Bumped `PROTOCOL_VERSION` to 2 for resumable progress: `session_progress` events now carry a per-session `sequence` and a stable `turnId`, session snapshots carry `lastSequence`, and a new `resume` command/result replays missed events or resets to an authoritative snapshot.
- Restricted assistant and tool transcript lifecycle schemas to valid state combinations and terminal items.

### Added

- Added transport-neutral CBOR protocol schemas, codecs, and length-prefixed framing for remote pi sessions.
