/**
 * Admin Auth Context（WB-002 / SPEC §9.1；v3 自动连接）。
 *
 * 控制台**不再让用户输入 Admin Token**：
 * - dev: Vite proxy 在转发 `/api/control/*` 时自动注入 `Authorization: Bearer <token>`
 *   （读取 dev 脚本产出的 `PI_CONTROL_ADMIN_TOKEN_FILE`）；前端只需给
 *   controller 设置任意占位 token 即可让上游 API 走通
 * - 真正生产环境的鉴权方案留给后续接入；本 PR 只移除"输入管理员 token"
 *   这一交互，service-layer auth 仍由 proxy / 网关层负责
 *
 * 流程：
 *   mount → controller.connect(<dev placeholder>) → fetchSession()（proxy
 *   自动注入真 token）→ completeConnection({ id, name }) → snapshot.state
 *   从 connecting 推进到 connected。任何 401 / 网络错误会让状态落到
 *   `error` 并清空 controller 内的占位 token（dev 场景下通常意味着 proxy
 *   没读到 token 文件，需检查 `start-admin-dev.sh`）。
 */

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { AdminAuthController, type AdminAuthSnapshot } from "../../publishing/auth-controller.ts";
import { AdminSessionApi, AdminSessionApiError } from "../api/session-api.ts";

/**
 * 占位 token：dev 模式下 vite proxy 会替换为真实 token；prod 由反向代理
 * 网关负责注入真实凭据。前端任何位置都禁止读取/打印这个值。
 */
const DEV_PLACEHOLDER_TOKEN = "dev-bypass-placeholder";

export interface AdminAuthContextValue {
	readonly snapshot: AdminAuthSnapshot;
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

	useEffect(() => {
		// 自动连接：放进 controller 一个占位 token 供上游 API 客户端使用；
		// 真正鉴权由 vite proxy（dev）或网关（prod）注入真实 token 完成。
		let cancelled = false;
		const connect = async (): Promise<void> => {
			ctrl.connect(DEV_PLACEHOLDER_TOKEN);
			const api = new AdminSessionApi({ auth: ctrl });
			try {
				const session = await api.fetchSession();
				if (cancelled) return;
				await ctrl.completeConnection({
					id: session.tenantId,
					name: session.tenantName,
				});
			} catch (err) {
				if (cancelled) return;
				const message =
					err instanceof AdminSessionApiError
						? `Admin session check failed (HTTP ${err.httpStatus})`
						: err instanceof Error
							? err.message
							: "Admin session check failed";
				ctrl.failConnection(message);
			}
		};
		void connect();
		return () => {
			cancelled = true;
		};
	}, [ctrl]);

	const value: AdminAuthContextValue = {
		snapshot,
		controller: ctrl,
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
