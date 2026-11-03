import type { ReservedSql } from "postgres";
import { OrchestrationError } from "./contracts.ts";
import type { OrchestrationService } from "./service.ts";

/** One active scheduler per tenant. Keeps its lock connection until all executions have stopped. */
export async function startOrchestrationDispatcher(service: OrchestrationService, onError: () => void) {
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
			`select a.id,a.turn_id,w.conversation_id from orchestration_assignments a
		join orchestration_work_items w on w.id=a.work_item_id where a.tenant_id=$1 and a.state='running' order by a.created_at`,
			store.tenantId,
		);
		for (const row of rows) {
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
			"update orchestration_credentials set sealed='{}'::jsonb where tenant_id=$1 and expires_at<now() and sealed<>'{}'::jsonb",
			store.tenantId,
		);
		while (!stopped && active.size < 3) {
			const assignment = await store.claim();
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
