/**
 * Admin chat Voice Mode hook.
 *
 * Mirrors the embed `voiceEngine` shape so the workspace can render the new
 * `VoiceModeToggle` + `VoiceModePanel` without a separate code path. The
 * underlying transport / ASR / TTS classes are the same ones used by the
 * published chat (`VoiceEngineTransport`, `VoiceAsrSession`, `VoiceTtsSession`);
 * this hook just wires them with admin-side auth.
 *
 * The hook is deliberately forgiving: if the ticket endpoint isn't reachable
 * (the embed auth route is not exposed to admin tokens in this build), the
 * toggle still flips mode, but the transport stays in `closed` and the panel
 * surfaces a friendly hint. No exceptions escape — UI never breaks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoiceAsrSession, type VoiceAsrState } from "../../embed/voice-asr-session.ts";
import { type VoiceEngineStatus, VoiceEngineTransport } from "../../embed/voice-engine-transport.ts";
import { cleanupVoiceMode, type PublishedChatMode } from "../../embed/voice-mode.ts";
import { currentVisibleAssistant, type VoiceTtsPhase, VoiceTtsSession } from "../../embed/voice-tts-session.ts";

export interface VoiceModeBundle {
	readonly status: VoiceEngineStatus;
	readonly asr: VoiceAsrState;
	readonly mode: PublishedChatMode;
	readonly tts: VoiceTtsPhase;
	readonly onToggle: () => void;
}

export interface UseVoiceModeOptions {
	/** Authentication bearer the admin page already uses for the WS. */
	readonly token?: string;
}

interface AdminVoiceApi {
	getVoiceEngineWsTicket(token: string): Promise<{ ticket: string; voiceEngineUrl: string; expiresAt: string }>;
}

const VOICE_TICKET_PATH = "/api/embed/v1/voice-engine/ws-ticket";

function defaultAdminVoiceApi(): AdminVoiceApi {
	return {
		async getVoiceEngineWsTicket(token) {
			const response = await fetch(VOICE_TICKET_PATH, {
				method: "POST",
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
			if (!response.ok) {
				throw new Error(`voice ticket ${response.status}`);
			}
			const payload = (await response.json()) as {
				data?: { ticket: string; voiceEngineUrl: string; expiresAt: string };
			};
			if (!payload.data) throw new Error("voice ticket missing data");
			return payload.data;
		},
	};
}

export function useVoiceMode({ token }: UseVoiceModeOptions): VoiceModeBundle {
	const [mode, setMode] = useState<PublishedChatMode>("text");
	const [status, setStatus] = useState<VoiceEngineStatus>("disconnected");
	const [asr, setAsr] = useState<VoiceAsrState>({ phase: "idle" });
	const [tts, setTts] = useState<VoiceTtsPhase>("idle");
	const transportRef = useRef<VoiceEngineTransport | null>(null);
	const asrRef = useRef<VoiceAsrSession | null>(null);
	const ttsRef = useRef<VoiceTtsSession | null>(null);
	const intentionalCloseRef = useRef(false);
	const startAsrOnConnectRef = useRef(false);

	const apiRef = useRef<AdminVoiceApi>(defaultAdminVoiceApi());

	// Lazily construct the transport + ASR + TTS sessions. Kept in refs so the
	// toggle handler can reach them without re-creating on every state change.
	const ensureTransport = useCallback((): VoiceEngineTransport | null => {
		if (transportRef.current !== null) return transportRef.current;
		const asrSession = new VoiceAsrSession({
			send: (frame) => transportRef.current?.send(frame) ?? false,
			onState: setAsr,
		});
		const ttsSession = new VoiceTtsSession({
			send: (frame) => transportRef.current?.send(frame) ?? false,
			onPhase: setTts,
		});
		const transport = new VoiceEngineTransport({
			getTicket: (authToken) => apiRef.current.getVoiceEngineWsTicket(authToken),
			onStatus: (next) => {
				setStatus(next);
				if (next === "connected" && startAsrOnConnectRef.current) {
					startAsrOnConnectRef.current = false;
					void asrSession.start();
				} else if (next === "closed") {
					startAsrOnConnectRef.current = false;
					void ttsSession.stop(false);
					if (intentionalCloseRef.current) intentionalCloseRef.current = false;
					else void asrSession.handleDisconnect();
				}
			},
			onMessage: (data) => {
				asrSession.handleMessage(data);
				ttsSession.handleMessage(data);
			},
		});
		transportRef.current = transport;
		asrRef.current = asrSession;
		ttsRef.current = ttsSession;
		return transport;
	}, []);

	// Seed the TTS session with an initial visible-assistant target. The admin
	// page doesn't push new assistant messages through this hook, so the seed
	// is a no-op (TTS stays best-effort here).
	useEffect(() => {
		const ttsSession = ttsRef.current;
		if (ttsSession === null) return;
		const visible = currentVisibleAssistant([]);
		ttsSession.observeVisibleAssistant(visible.id, visible.text, visible.status);
	}, []);

	const onToggle = useCallback(async (): Promise<void> => {
		if (mode === "voice") {
			setMode("text");
			startAsrOnConnectRef.current = false;
			intentionalCloseRef.current = true;
			const transport = transportRef.current;
			const asrSession = asrRef.current;
			const ttsSession = ttsRef.current;
			if (asrSession !== null && ttsSession !== null && transport !== null) {
				await cleanupVoiceMode({ asr: asrSession, tts: ttsSession, transport });
			}
			setAsr({ phase: "idle" });
			setTts("idle");
			return;
		}
		setMode("voice");
		const transport = ensureTransport();
		if (transport === null) return;
		const ttsSession = ttsRef.current;
		ttsSession?.enable();
		if (transport.currentStatus === "connected") {
			await asrRef.current?.start();
			return;
		}
		startAsrOnConnectRef.current = true;
		try {
			await transport.connect(token ?? "");
		} catch {
			// The transport already routes failures to status; swallow here so
			// the click handler stays synchronous from the React perspective.
		}
	}, [ensureTransport, mode, token]);

	// Cleanup on unmount: leave voice mode if still active.
	useEffect(() => {
		return () => {
			const transport = transportRef.current;
			const asrSession = asrRef.current;
			const ttsSession = ttsRef.current;
			if (asrSession !== null && ttsSession !== null && transport !== null) {
				void cleanupVoiceMode({ asr: asrSession, tts: ttsSession, transport });
			}
			transportRef.current = null;
			asrRef.current = null;
			ttsRef.current = null;
		};
	}, []);

	return useMemo(
		() => ({ status, asr, mode, tts, onToggle: () => void onToggle() }),
		[status, asr, mode, tts, onToggle],
	);
}
