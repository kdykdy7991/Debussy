/**
 * Debug event payload byte computation (mirrors the Production event log so a
 * future `payload_bytes` counter can advance atomically without re-reading).
 */
export function computeDebugPayloadBytes(payload: unknown): number {
	const json = JSON.stringify(payload);
	return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}
