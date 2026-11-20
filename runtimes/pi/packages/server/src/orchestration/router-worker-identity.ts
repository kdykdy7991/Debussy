import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";

function localProcessScope(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (!bootId) return undefined;
		return createHash("sha256")
			.update(JSON.stringify([hostname(), bootId, readlinkSync("/proc/self/ns/pid")]))
			.digest("hex");
	} catch {
		return undefined;
	}
}

function processStartTime(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	if (!startTime || !/^\d+$/.test(startTime)) throw new Error("Cannot read process start time");
	return startTime;
}

export function routerWorkerIdentity(): string {
	const scope = localProcessScope();
	if (scope !== undefined) {
		try {
			return `proc:${process.pid}:${processStartTime(process.pid)}:${randomUUID()}:${scope}`;
		} catch {
			// An opaque identity still fences writes, but cannot prove process exit.
		}
	}
	return randomUUID();
}

export function routerWorkerHasExited(identity: string): boolean {
	const match = /^proc:([1-9]\d*):(\d+):[\da-f-]+:([\da-f]{64})$/.exec(identity);
	if (!match || match[3] !== localProcessScope()) return false;
	try {
		return processStartTime(Number(match[1])) !== match[2];
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT";
	}
}
