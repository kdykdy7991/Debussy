# Changelog

## [Unreleased]

### Added

- Added the experimental transport-neutral `PiClient` and multi-session `PiSessionHandle` APIs with structured `PiServerError` responses.
- Track the last acknowledged `session_progress` sequence per session, drop duplicate events and events already covered by a newer snapshot, and automatically resume (replay missed events via the protocol v2 `resume` command) when re-attaching a session after a reconnect.
