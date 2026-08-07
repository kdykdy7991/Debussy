/**
 * Lexical tokenizer + BM25 ranking for P2 citation retrieval.
 *
 * Text is tokenized without any external dependency: Latin/digit runs become
 * lowercased word tokens, and CJK runs become overlapping character bigrams so
 * keyword matching works on space-free scripts. Ranking is standard BM25 over
 * the chunks of one session, which is deterministic and unit-testable.
 */

export function isCjkCharacter(char: string): boolean {
	const code = char.codePointAt(0);
	if (code === undefined) return false;
	return (
		(code >= 0x2e80 && code <= 0x2eff) || // CJK Radicals Supplement
		(code >= 0x2f00 && code <= 0x2fdf) || // Kangxi Radicals
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
		(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
		(code >= 0x20000 && code <= 0x2a6df) // CJK Unified Ideographs Extension B
	);
}

/**
 * Split text into search tokens. Latin words are lowercased and lightly stemmed
 * so simple English plurals (dogs → dog, boxes → box) match their singular form;
 * CJK runs are emitted as bigrams (single-character runs emit that character so
 * short queries can still match). Duplicate tokens are preserved for TF counting.
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	for (const match of lower.matchAll(/[a-z0-9]+/g)) tokens.push(stemLatin(match[0]));
	let cjkRun: string[] = [];
	const flushCjk = () => {
		if (cjkRun.length === 1) {
			tokens.push(cjkRun[0]!);
		} else if (cjkRun.length > 1) {
			for (let index = 0; index < cjkRun.length - 1; index++) {
				tokens.push(`${cjkRun[index]}${cjkRun[index + 1]}`);
			}
		}
		cjkRun = [];
	};
	for (const char of lower) {
		if (isCjkCharacter(char)) cjkRun.push(char);
		else flushCjk();
	}
	flushCjk();
	return tokens;
}

export interface RankedChunk<T> {
	chunk: T;
	score: number;
}

/**
 * Rank chunks against a tokenized query using BM25. Chunks with no query term
 * are omitted; ties are broken by chunk ordinal so results are stable.
 */
export function rankChunks<T extends { ordinal: number; text: string }>(
	chunks: readonly T[],
	queryTokens: readonly string[],
	k1 = 1.5,
	b = 0.75,
): RankedChunk<T>[] {
	if (chunks.length === 0 || queryTokens.length === 0) return [];
	const tokenCounts = chunks.map((chunk) => countTokens(chunk.text));
	const documentFrequencies = new Map<string, number>();
	for (const chunk of chunks) {
		const seen = new Set(tokenize(chunk.text));
		for (const token of seen) documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
	}
	const averageLength = chunks.reduce((sum, chunk) => sum + tokenLength(chunk.text), 0) / chunks.length || 1;

	const results: RankedChunk<T>[] = [];
	for (let index = 0; index < chunks.length; index++) {
		const counts = tokenCounts[index]!;
		const length = tokenLength(chunks[index]!.text);
		const denominator = length || 1;
		let score = 0;
		const seen = new Set<string>();
		for (const token of queryTokens) {
			if (seen.has(token)) continue;
			seen.add(token);
			const frequency = counts.get(token) ?? 0;
			if (frequency === 0) continue;
			const df = documentFrequencies.get(token) ?? 0;
			const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
			score += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * denominator) / averageLength));
		}
		if (score > 0) results.push({ chunk: chunks[index]!, score });
	}
	results.sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal);
	return results;
}

/** A rough token estimate used for retrieval context budgeting. */
export function estimateTokens(text: string): number {
	let cjk = 0;
	for (const char of text) if (isCjkCharacter(char)) cjk++;
	return Math.ceil((text.length - cjk) / 4 + cjk / 1.5);
}

/**
 * Light English plural stemmer used so lexical retrieval matches "dogs" against
 * "dog" and "classes" against "class". Conservative: never strips a trailing
 * "ss"/"us" and leaves short words untouched, so unrelated tokens ("bus", "kiss")
 * are not corrupted.
 */
function stemLatin(word: string): string {
	if (word.length <= 3) return word;
	if (word.endsWith("sses")) return word.slice(0, -2); // classes → class
	if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`; // stories → story
	if (
		word.endsWith("ses") ||
		word.endsWith("xes") ||
		word.endsWith("zes") ||
		word.endsWith("ches") ||
		word.endsWith("shes")
	) {
		return word.slice(0, -2); // boxes → box
	}
	if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1); // dogs → dog
	return word;
}

function countTokens(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function tokenLength(text: string): number {
	return tokenize(text).length;
}
