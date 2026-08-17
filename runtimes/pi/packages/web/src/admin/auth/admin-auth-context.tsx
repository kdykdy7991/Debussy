/**
 * Admin Auth Context（WB-002 / SPEC §9.1）。
 *
 * 把现有的 `AdminAuthController` 暴露为 React Context：状态从 controller
 * 读取，写入（解锁/锁定/401）调用 controller。Token 永远只在 controller
 * 内存里；React 层只持有 `state`、`baseUrl`、`tenant` 这些**不敏感**的
 * 投影。
 *
 * 不使用任何 Storage、URL、console 或异常文本持久化 token。
 */

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { AdminAuthController, type AdminAuthSnapshot } from "../../publishing/auth-controller.ts";

export interface AdminAuthContextValue {
	readonly snapshot: AdminAuthSnapshot;
	readonly unlock: (token: string) => Promise<void>;
	readonly lock: () => void;
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
			try {
				// 占位：真实 tenant 拉取由 PublishingApi 在 WB-004 接入。
				// 当前只把状态推进到 connected 以演示解锁流程；后续 WB-004 替换。
				await ctrl.completeConnection({ id: "ten_placeholder", name: "默认租户" });
			} catch (err) {
				ctrl.failConnection(err instanceof Error ? err.message : "unlock failed");
				throw err;
			}
		},
		lock: () => {
			ctrl.lock();
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
