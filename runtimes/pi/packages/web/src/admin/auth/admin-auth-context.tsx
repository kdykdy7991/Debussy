/**
 * Admin Auth Context（WB-002 / SPEC §9.1；MVP-01 真实解锁）。
 *
 * 把现有的 `AdminAuthController` 暴露为 React Context：状态从 controller
 * 读取，写入（解锁/锁定/401）调用 controller。Token 永远只在 controller
 * 内存里；React 层只持有 `state`、`baseUrl`、`tenant` 这些**不敏感**的
 * 投影。
 *
 * 不使用任何 Storage、URL、console 或异常文本持久化 token。解锁流程必须
 * 走 AdminSessionApi 调 `GET /api/control/v1/session` 验证；服务端返回
 * 成功后才把状态推进到 `connected`。任何 401 或网络错误都会把 controller
 * 推回 `error` 并清空内存 token。
 */

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { AdminAuthController, type AdminAuthSnapshot } from "../../publishing/auth-controller.ts";
import { AdminSessionApi, AdminSessionApiError } from "../api/session-api.ts";

export interface AdminAuthContextValue {
	readonly snapshot: AdminAuthSnapshot;
	readonly unlock: (token: string) => Promise<void>;
	readonly lock: () => void;
	readonly setBaseUrl: (baseUrl: string) => void;
	readonly markApiError: (status: number, message: string) => void;
	readonly controller: AdminAuthController;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export interface AdminAuthProviderProps {
	readonly controller?: AdminAuthController;
	readonly baseUrl?: string;
	readonly children: ReactNode;
}

export function AdminAuthProvider({ controller, baseUrl, children }: AdminAuthProviderProps): React.ReactElement {
	const [ctrl] = useState(() => controller ?? new AdminAuthController({ initialBaseUrl: baseUrl ?? "" }));
	const [snapshot, setSnapshot] = useState<AdminAuthSnapshot>(() => ctrl.getSnapshot());

	useEffect(() => {
		const unsubscribe = ctrl.subscribe(setSnapshot);
		return () => {
			unsubscribe();
		};
	}, [ctrl]);

	const value: AdminAuthContextValue = {
		snapshot,
		controller: ctrl,
		unlock: async (token: string) => {
			const trimmed = token.trim();
			if (trimmed === "") return;
			ctrl.connect(trimmed);
			const api = new AdminSessionApi({ auth: ctrl });
			try {
				const session = await api.fetchSession();
				// Server-derived projection only; never fall back to a static
				// placeholder if the endpoint succeeds.
				await ctrl.completeConnection({
					id: session.tenantId,
					name: session.tenantName,
				});
			} catch (err) {
				const message =
					err instanceof AdminSessionApiError
						? `Admin token rejected (HTTP ${err.httpStatus})`
						: err instanceof Error
							? err.message
							: "Admin token verification failed";
				// controller.failConnection wipes the in-memory token; listeners
				// observe state=error and the workbench re-renders the lock UI.
				ctrl.failConnection(message);
				throw err instanceof Error ? err : new Error(message);
			}
		},
		lock: () => {
			ctrl.lock();
		},
		setBaseUrl: (baseUrl: string) => {
			ctrl.setBaseUrl(baseUrl);
		},
		markApiError: (status: number, message: string) => {
			if (status === 401) {
				ctrl.failConnection(message);
			}
		},
	};

	return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
	const ctx = useContext(AdminAuthContext);
	if (ctx === null) {
		throw new Error("useAdminAuth must be used inside <AdminAuthProvider>");
	}
	return ctx;
}
