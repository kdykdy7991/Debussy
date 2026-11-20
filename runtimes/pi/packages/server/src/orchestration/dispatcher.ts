import type { ReservedSql } from "postgres";
import { CONNECTION_FAILED, CREDENTIAL_EXPIRED, MCP_AUTH_FAILED, MCP_RESULT_BLOCKED } from "./api-key-boundary.ts";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationService } from "./service.ts";

/** One active scheduler per tenant. Keeps its lock connection until all executions have stopped. */
export async function startOrchestrationDispatcher(
	service: OrchestrationService,
	onError: () => void,
	options: { legacyOnly?: boolean } = {},
) {
	const { store } = service;
	const lock: ReservedSql = await store.client.withDriver((sql) => sql.reserve());
	const key = `debussy:orchestration:${store.tenantId}`;
	const acquired =
		await lock`select pg_try_advisory_lock(hashtextextended(${key},0)) as acquired,pg_backend_pid() as pid`.catch(
			(error) => {
				lock.release();
				throw error;
			},
		);
	if (acquired[0]?.acquired !== true) {
		lock.release();
		throw new Error("Another orchestration dispatcher already owns this tenant");
	}
	const pid = acquired[0]!.pid;
	let stopped = false,
		busy: Promise<void> | undefined;
	const active = new Map<string, Promise<void>>();
	const recover = async () => {
		const rows = await store.client.run(
			`select a.id,a.turn_id,a.error,w.conversation_id,w.key_id from orchestration_assignments a
		join orchestration_work_items w on w.id=a.work_item_id
		join orchestration_integrations i on i.id=w.integration_id and i.tenant_id=w.tenant_id
		where a.tenant_id=$1 and a.state='running' and (not $2::boolean or (w.key_id is null and i.kind='legacy')) order by a.created_at`,
			store.tenantId,
			options.legacyOnly === true,
		);
		for (const row of rows) {
			// A persisted fatal boundary hit is terminal: the Run must never be
			// judged successful, not even when the model already committed output.
			const fatal = row.error === null || row.error === undefined ? undefined : String(row.error);
			if (
				fatal === MCP_RESULT_BLOCKED ||
				fatal === MCP_AUTH_FAILED ||
				fatal === CREDENTIAL_EXPIRED ||
				fatal === CONNECTION_FAILED
			) {
				await store.complete(String(row.id), null, fatal);
				continue;
			}
			// A process can stop after observing a fatal MCP response but before its
			// marker is durable. A committed message alone cannot prove that a Key
			// Run passed the boundary, so recover these interrupted Runs fail-closed.
			if (row.key_id != null) {
				await store.complete(String(row.id), null, "EXECUTION_INTERRUPTED");
				continue;
			}
			const output = await store.client.run(
				`select payload->>'text' as text from conversation_events e where e.tenant_id=$1
			and e.conversation_id=$2 and e.turn_id=$3 and e.event_type='assistant/message'
			and exists(select 1 from conversation_events t where t.conversation_id=e.conversation_id and t.turn_id=e.turn_id and t.event_type='turn/end')
			order by sequence desc limit 1`,
				store.tenantId,
				String(row.conversation_id),
				String(row.turn_id),
			);
			try {
				if (!output[0] || typeof output[0].text !== "string") throw new Error("No committed result");
				const text = await service.validateOutput(String(row.conversation_id), String(row.turn_id), output[0].text);
				await store.complete(String(row.id), text, null);
			} catch (error) {
				await store.complete(
					String(row.id),
					null,
					error instanceof OrchestrationError ? error.code : "EXECUTION_INTERRUPTED",
				);
			}
		}
	};
	try {
		await recover();
	} catch (error) {
		await lock`select pg_advisory_unlock(hashtextextended(${key},0))`;
		lock.release();
		throw error;
	}
	const pass = async () => {
		if (stopped) return;
		try {
			const check = await lock`select pg_backend_pid() as pid`;
			if (check[0]?.pid !== pid) throw new Error("Orchestration lock connection changed");
		} catch (error) {
			stopped = true;
			await Promise.allSettled([...active.keys()].map((id) => service.abort(id)));
			throw error;
		}
		await store.client.run(
			`update orchestration_credentials c set sealed='{}'::jsonb where c.tenant_id=$1 and c.expires_at<now() and c.sealed<>'{}'::jsonb
			and (not $2::boolean or exists (select 1 from orchestration_assignments a
			join orchestration_work_items w on w.id=a.work_item_id and w.tenant_id=a.tenant_id
			join orchestration_integrations i on i.id=w.integration_id and i.tenant_id=w.tenant_id
			where a.credential_id=c.id and a.tenant_id=c.tenant_id and w.key_id is null and i.kind='legacy'))`,
			store.tenantId,
			options.legacyOnly === true,
		);
		// The database is the cross-process cancellation signal. Retry while the
		// execution remains active, including while its runtime is still opening.
		for (const id of active.keys()) {
			const rows = await store.client.run(
				"select state from orchestration_work_items where tenant_id=$1 and id=$2",
				store.tenantId,
				id,
			);
			if (rows[0]?.state === "cancelled") await service.abort(id).catch(onError);
		}
		while (!stopped && active.size < 3) {
			const assignment = await store.claim(options.legacyOnly === true);
			if (!assignment) break;
			const run = (async () => {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				try {
					const age = await store.client.run(
						"select extract(epoch from(now()-created_at))*1000 as age from orchestration_assignments where id=$1",
						assignment.id,
					);
					if (Number(age[0]?.age) > assignment.settings.queueTimeoutMs)
						throw new OrchestrationError(408, "QUEUE_TIMEOUT", "排队超时");
					timeout = setTimeout(() => {
						timedOut = true;
						void service.abort(assignment.workItemId).catch(onError);
					}, 600_000);
					const report = await service.execute(assignment);
					await store.complete(assignment.id, timedOut ? null : report, timedOut ? "EXECUTION_TIMEOUT" : null);
				} catch (error) {
					await store.complete(
						assignment.id,
						null,
						timedOut
							? "EXECUTION_TIMEOUT"
							: error instanceof OrchestrationError
								? error.code
								: "EXECUTION_FAILED",
					);
				} finally {
					if (timeout) clearTimeout(timeout);
				}
			})();
			active.set(assignment.workItemId, run);
			void run.catch(onError).finally(() => active.delete(assignment.workItemId));
		}
	};
	const tick = () => {
		if (busy || stopped) return;
		busy = pass()
			.catch(() => {
				onError();
			})
			.finally(() => {
				busy = undefined;
			});
	};
	const timer = setInterval(tick, 500);
	timer.unref();
	tick();
	let closing: Promise<void> | undefined;
	return {
		close() {
			closing ??= (async () => {
				stopped = true;
				clearInterval(timer);
				try {
					await busy;
					// An aborted runtime can return an empty output as if it succeeded.
					// Settle active Key Runs under the normal lifecycle lock before
					// requesting cancellation; a concurrent terminal state wins.
					for (const workId of active.keys()) {
						const rows = await store.client.run(
							`select a.id,a.error from orchestration_assignments a join orchestration_work_items w
							on w.id=a.work_item_id and w.tenant_id=a.tenant_id
							where a.tenant_id=$1 and w.id=$2 and w.key_id is not null and a.state='running'`,
							store.tenantId,
							workId,
						);
						if (rows[0]) {
							const code = String(rows[0].error ?? "");
							await store.complete(
								String(rows[0].id),
								null,
								[MCP_RESULT_BLOCKED, MCP_AUTH_FAILED, CREDENTIAL_EXPIRED, CONNECTION_FAILED].includes(code)
									? code
									: "EXECUTION_INTERRUPTED",
							);
						}
					}
					await Promise.allSettled([...active.keys()].map((id) => service.abort(id)));
					await Promise.allSettled([...active.values()]);
				} finally {
					try {
						await lock`select pg_advisory_unlock(hashtextextended(${key},0))`;
					} finally {
						lock.release();
					}
				}
			})();
			return closing;
		},
	};
}
