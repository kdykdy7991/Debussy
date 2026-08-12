export { PiClient } from "./client.ts";
export {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
} from "./errors.ts";
export type {
	AcquireSessionOptions,
	PiSessionHandle,
	SessionLease,
	SessionLeaseMode,
	SessionPromptOptions,
} from "./session-handle.ts";
export {
	isLiveSpeechTerminal,
	isSpeechTerminal,
	LiveSpeechJobHandleImpl,
	SpeechJobHandleImpl,
} from "./speech-handle.ts";
export type {
	LiveSpeechStreamResult,
	OpenLiveSpeechStreamOptions,
	OpenSpeechStreamOptions,
	SpeechStream,
	SpeechStreamErrorCode,
} from "./speech-stream.ts";
export { openLiveSpeechStream, openSpeechStream, SpeechStreamError } from "./speech-stream.ts";
export type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
export type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	ListenerErrorHandler,
	LiveSpeechJobHandle,
	PiClientOptions,
	SpeechJobHandle,
	StartSpeechOptions,
	Unsubscribe,
} from "./types.ts";
