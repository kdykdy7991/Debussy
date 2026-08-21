export type AgentReaction = "playful";

const NEGATIVE_PRAISE_PATTERNS = [
	/不(?:是)?(?:太|够|怎么|很|那么|这么)?好/,
	/没(?:有)?(?:那么|这么|很)?好/,
	/谈不上(?:好|不错|完美)/,
	/并不(?:好|棒|完美)/,
	/不(?:是)?(?:太|很|那么|这么)?(?:棒|完美|满意|靠谱)/,
	/\b(?:not|isn['’]?t|wasn['’]?t|aren['’]?t|weren['’]?t)\s+(?:very\s+)?(?:good|great|nice|perfect)\b/,
	/\bno\s+good\b/,
];

const EXPLICIT_PRAISE_PATTERNS = [
	/(?:非常|特别|真的|真|很|挺|太)?好(?:了|啊|呀|耶)?(?:[，,。.!！]|$)/,
	/(?:真|很|挺|太|非常)?不错/,
	/(?:做|干)得(?:真|很|非常)?(?:好|漂亮|棒)/,
	/(?:太|真|非常)?棒(?:了|啊|呀)?/,
	/(?:太|真|非常)?厉害(?:了|啊)?/,
	/(?:非常|很|真)?完美/,
	/(?:很|真|非常)?靠谱/,
	/(?:很|非常)?满意/,
	/\b(?:good job|well done|nice work|great work|looks good|love it)\b/,
	/\b(?:great|awesome|excellent|perfect)\b[!.，,。！]?/,
];

/** Conservative, local-only praise detection for transient avatar reactions. */
export function detectAgentReaction(message: string): AgentReaction | undefined {
	const normalized = message.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
	if (!normalized || NEGATIVE_PRAISE_PATTERNS.some((pattern) => pattern.test(normalized))) return undefined;
	return EXPLICIT_PRAISE_PATTERNS.some((pattern) => pattern.test(normalized)) ? "playful" : undefined;
}
