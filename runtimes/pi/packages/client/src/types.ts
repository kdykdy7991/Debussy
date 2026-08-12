import type {
	LiveSpeechJob,
	ModelRef,
	SpeechJob,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConnectionStateChange {
	state: ConnectionState;
	error?: Error;
}

export type Unsubscribe = () => void;
export type ListenerErrorHandler = (error: Error) => void;

export interface PiClientOptions {
	transportFactory: ByteTransportFactory;
	maxFrameLength?: number;
	/** Reports subscriber failures without allowing them to corrupt client state. */
	onListenerError?: ListenerErrorHandler;
}

export interface CreateSessionOptions {
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export interface StartSpeechOptions {
	sessionId: string;
	messageId: string;
	voiceProfileId?: string;
}

/**
 * Control-plane handle for one speech job. Job events are delivered only to the
 * connection that created the job; subscribers receive each state advance until
 * the job reaches a terminal status.
 */
export interface SpeechJobHandle {
	readonly job: SpeechJob;
	subscribe(listener: (job: SpeechJob) => void): Unsubscribe;
	cancel(): Promise<SpeechJob>;
}

/**
 * Control-plane handle for one Phase 2 live朗读 job. Job events are delivered
 * only to the connection that created the job; subscribers receive each state
 * advance until the job reaches a terminal status. The V5 contract freezes the
 * shape; the V8 server coordinator is the only legitimate creator.
 */
export interface LiveSpeechJobHandle {
	readonly job: LiveSpeechJob;
	subscribe(listener: (job: LiveSpeechJob) => void): Unsubscribe;
	cancel(): Promise<LiveSpeechJob>;
}
