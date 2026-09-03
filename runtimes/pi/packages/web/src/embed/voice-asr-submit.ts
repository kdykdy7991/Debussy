/**
 * Bridges a final ASR event into the exact text submission function used by
 * the composer. Identity and conversation context remain owned by that
 * existing function/store; the voice layer only supplies text.
 */
export function submitAsrFinalOnce(
	requestId: string,
	text: string,
	submittedRequestIds: Set<string>,
	submitText: (text: string) => boolean,
): boolean {
	if (!text.trim() || submittedRequestIds.has(requestId)) return false;
	if (!submitText(text)) return false;
	submittedRequestIds.add(requestId);
	return true;
}
