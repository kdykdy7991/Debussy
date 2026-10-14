export const NEAR_BOTTOM_PX = 96;

/** Layout and scroll anchoring must not be mistaken for a reader scrolling up. */
export function nextConversationFollow(
	following: boolean,
	previousTop: number,
	currentTop: number,
	distanceFromBottom: number,
	pointerDragging = false,
	readerScrollingDown = false,
): boolean {
	if (pointerDragging && currentTop < previousTop - 1) return false;
	if (!following && readerScrollingDown && currentTop > previousTop + 1 && distanceFromBottom <= NEAR_BOTTOM_PX)
		return true;
	return following;
}
