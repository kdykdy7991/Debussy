/**
 * Coding Agent integration for the Pi server.
 *
 * This module adapts the existing Coding Agent runtime (sessions, models, tools,
 * persistence) to the server-side `PiSessionBackend` boundary so the WebSocket
 * / Unix transports can drive Coding Agent sessions through the protocol.
 *
 * Consumers wire the backend into `new PiServer(backend, options)` and start
 * the resulting server normally; everything else (listener setup, snapshot
 * publishing, command dispatch) is provided by the existing server code.
 */
export {
	CodingAgentPiSessionBackend,
	type CodingAgentPiSessionBackendOptions,
} from "./backend.ts";
export {
	__testing as __progressAdapterTesting,
	subscribeToAgentSession,
} from "./progress-adapter.ts";
export { CodingAgentPiSessionRuntime } from "./runtime.ts";
export {
	__testing as __snapshotAdapterTesting,
	buildSessionSnapshot,
	type RuntimeHints,
} from "./snapshot-adapter.ts";
