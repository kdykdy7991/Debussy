import { PiServerError } from "../errors.ts";
import type { VoiceProfile } from "./types.ts";

/** The built-in profile used when the server supplies none. Matches the V1 default voice. */
export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
	id: "default",
	name: "Default",
	provider: "qwen3-tts",
	language: "Chinese",
	speaker: "Vivian",
};

/** Validate one profile entry at startup; config errors fail fast, never at request time. */
export function normalizeVoiceProfile(input: unknown, index: number): VoiceProfile {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new TypeError(`Voice profile ${index} must be an object`);
	}
	const record = input as Record<string, unknown>;
	const { id, name, provider, language, speaker, instruct } = record;
	if (typeof id !== "string" || id.length === 0) {
		throw new TypeError(`Voice profile ${index} must have a non-empty id`);
	}
	if (provider !== undefined && provider !== "qwen3-tts") {
		throw new TypeError(`Voice profile ${id} uses unsupported provider: ${String(provider)}`);
	}
	if (typeof language !== "string" || language.length === 0) {
		throw new TypeError(`Voice profile ${id} must have a non-empty language`);
	}
	if (typeof speaker !== "string" || speaker.length === 0) {
		throw new TypeError(`Voice profile ${id} must have a non-empty speaker`);
	}
	if (name !== undefined && typeof name !== "string") {
		throw new TypeError(`Voice profile ${id} name must be a string`);
	}
	if (instruct !== undefined && typeof instruct !== "string") {
		throw new TypeError(`Voice profile ${id} instruct must be a string`);
	}
	const profile: VoiceProfile = {
		id,
		provider: "qwen3-tts",
		language,
		speaker,
	};
	if (typeof name === "string" && name.length > 0) profile.name = name;
	if (typeof instruct === "string") profile.instruct = instruct;
	return profile;
}

/** Validate a list of profiles, guaranteeing unique ids and at least one entry. */
export function normalizeVoiceProfiles(input: readonly VoiceProfile[] | undefined): VoiceProfile[] {
	const source = input && input.length > 0 ? input : [DEFAULT_VOICE_PROFILE];
	const profiles = source.map((profile, index) => normalizeVoiceProfile(profile, index));
	const ids = new Set<string>();
	for (const profile of profiles) {
		if (ids.has(profile.id)) throw new TypeError(`Voice profile id is duplicated: ${profile.id}`);
		ids.add(profile.id);
	}
	return profiles;
}

/**
 * Resolve the profile for a request. Unknown profile ids surface as a
 * pre-creation `not_found` protocol error.
 */
export function resolveProfile(
	profiles: readonly VoiceProfile[],
	profileId: string | undefined,
	defaultProfileId: string,
): VoiceProfile {
	const id = profileId ?? defaultProfileId;
	const profile = profiles.find((candidate) => candidate.id === id);
	if (!profile) throw new PiServerError("not_found", `Unknown voice profile: ${id}`);
	return profile;
}
