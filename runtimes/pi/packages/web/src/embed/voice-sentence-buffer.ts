const SENTENCE_END = /[。！？!?；]/u;

/** Minimal punctuation-only buffer required by the frozen voice MVP. */
export class VoiceSentenceBuffer {
	private pending = "";

	push(delta: string): string[] {
		this.pending += delta;
		const sentences: string[] = [];
		let boundary = this.pending.search(SENTENCE_END);
		while (boundary >= 0) {
			const sentence = this.pending.slice(0, boundary + 1);
			this.pending = this.pending.slice(boundary + 1);
			if (sentence.trim()) sentences.push(sentence);
			boundary = this.pending.search(SENTENCE_END);
		}
		return sentences;
	}

	flush(): string[] {
		const tail = this.pending;
		this.pending = "";
		return tail.trim() ? [tail] : [];
	}

	clear(): void {
		this.pending = "";
	}
}
