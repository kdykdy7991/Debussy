/** Clipboard API requires a secure context; the fallback supports HTTP LAN embeds. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Try the selection-based browser fallback below.
		}
	}
	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	field.style.position = "fixed";
	field.style.left = "-9999px";
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	document.body.appendChild(field);
	field.focus();
	field.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
		previousFocus?.focus();
	}
}
