import { AvatarError } from "../core/errors.js";
import type { AvatarSpeechSession } from "../core/runtime.js";
import type {
  AvatarSpeechEndReason,
  AvatarSpeechInput,
} from "../core/types.js";
import { createDeferred, type Deferred } from "./deferred.js";

export type FakeAudioCall =
  | { method: "startSpeech"; input: AvatarSpeechInput }
  | { method: "finishSpeech"; reason: AvatarSpeechEndReason }
  | { method: "destroy" };

interface FakeSpeechSession extends AvatarSpeechSession {
  readonly deferred: Deferred<AvatarSpeechEndReason>;
  settled: boolean;
  cleanup(): void;
}

export class FakeAudio {
  readonly calls: FakeAudioCall[] = [];
  destroyed = false;
  #active: FakeSpeechSession | undefined;
  #nextStartError: unknown;

  get hasActiveSpeech(): boolean {
    return this.#active !== undefined;
  }

  rejectNextStart(error: unknown): void {
    this.#nextStartError = error;
  }

  async startSpeech(input: AvatarSpeechInput, signal: AbortSignal): Promise<AvatarSpeechSession> {
    if (this.destroyed) {
      throw new AvatarError("ALREADY_DESTROYED", "Fake audio has been destroyed");
    }
    if (signal.aborted) {
      throw new DOMException("Speech start was aborted", "AbortError");
    }
    if (this.#nextStartError !== undefined) {
      const error = this.#nextStartError;
      this.#nextStartError = undefined;
      throw error;
    }

    this.#settleActive("interrupted");
    this.calls.push({ method: "startSpeech", input });
    const deferred = createDeferred<AvatarSpeechEndReason>();
    const onAbort = (): void => {
      const reason = signal.reason === "stopped" ? "stopped" : "interrupted";
      this.#settle(session, reason);
    };
    const session: FakeSpeechSession = {
      deferred,
      finished: deferred.promise,
      settled: false,
      stop: (reason) => this.#settle(session, reason),
      cleanup: () => signal.removeEventListener("abort", onAbort),
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#active = session;
    return session;
  }

  finishSpeech(reason: AvatarSpeechEndReason = "completed"): void {
    if (!this.#active) {
      throw new AvatarError("INVALID_CONFIG", "Fake audio has no active speech to finish");
    }
    this.#settleActive(reason);
  }

  failSpeech(error: unknown = new Error("Fake audio playback failed")): void {
    const active = this.#active;
    if (!active) {
      throw new AvatarError("INVALID_CONFIG", "Fake audio has no active speech to fail");
    }
    active.settled = true;
    active.cleanup();
    this.#active = undefined;
    active.deferred.reject(error);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.#settleActive("interrupted");
    this.destroyed = true;
    this.calls.push({ method: "destroy" });
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  #settleActive(reason: AvatarSpeechEndReason): void {
    if (this.#active) {
      this.#settle(this.#active, reason);
    }
  }

  #settle(session: FakeSpeechSession, reason: AvatarSpeechEndReason): void {
    if (session.settled) {
      return;
    }
    session.settled = true;
    session.cleanup();
    if (this.#active === session) {
      this.#active = undefined;
    }
    this.calls.push({ method: "finishSpeech", reason });
    session.deferred.resolve(reason);
  }
}
