export interface SandboxPythonPackage {
	name: string;
	version: string;
	location: string;
}

export interface SandboxRuntimeInfo {
	name: "Bash" | "Python" | "Node.js";
	version: string;
	path: string;
}

export type AdminSandboxEnvironment = {
	provider: "Bubblewrap";
	bwrapVersion: string | null;
	os: string;
} & (
	| { available: false; error: "SANDBOX_UNAVAILABLE" | "SANDBOX_PROBE_FAILED" }
	| {
			available: true;
			runtimeDir: string;
			workspaceDir: string;
			runtimeReadOnly: true;
			workspaceMount: "/workspace";
			workspaceScope: "task";
			network: "isolated";
			executionPolicy: "per_bash_call";
			dependencyMode: "offline_preinstalled";
			runtimes: SandboxRuntimeInfo[];
			pythonPackages: SandboxPythonPackage[];
	  }
);

export type SandboxExecutionStatus = "success" | "command_failed" | "start_failed" | "timeout" | "canceled";

export interface AdminSandboxStatistics {
	total: number;
	counts: Record<SandboxExecutionStatus, number>;
	successRate: number | null;
	averageMs: number | null;
	p95Ms: number | null;
	/** Upgraded servers return hourly or daily counts for the entire selected range. */
	trend?: { startAt: string; count: number }[];
	recent: {
		id: string;
		keyId: string;
		taskId: string;
		operationId: string;
		tool: "bash";
		startedAt: string;
		endedAt: string;
		status: SandboxExecutionStatus;
		durationMs: number;
		reason: string | null;
	}[];
}
