/**
 * Embed Bootstrap 端点（spec 8.2，TASK-019）。
 *
 * `GET /api/embed/v1/bootstrap?publicAppId=pub_xxx`：公开应用摘要，供 iframe
 * 壳在无凭据时渲染主题与功能开关（只加载公开主题摘要，spec 25.4 —— 不暴露
 * 任何管理能力或内部配置）。与 Exchange 一样按 publicAppId 定位（公开定位
 * 符，非凭据）；App 不存在返回 404，不泄露其它信息。
 */
import {
	type PublishedAppId,
	type PublishedAppVersionId,
	parsePublicAppId,
	type TenantId,
} from "../publishing/domain/ids.ts";
import type { PublishedAppRecord, PublishingRepositories } from "../publishing/repositories.ts";
import { parseRuntimeSpec } from "../publishing/runtime-spec/schema.ts";
import { requestPathname } from "../transports/websocket/listener.ts";
import type { HttpRequestHandler } from "../types.ts";
import { errorEnvelope, jsonBody, readRequestId, respondPreflight, setEmbedCorsHeaders } from "./http-shared.ts";

export const EMBED_BOOTSTRAP_PATH = "/api/embed/v1/bootstrap";

export interface BootstrapHttpHandlerOptions {
	readonly repositories: PublishingRepositories;
	readonly onError?: (error: unknown) => void;
}

export function createBootstrapHttpHandler(options: BootstrapHttpHandlerOptions): HttpRequestHandler {
	return async (request, response): Promise<boolean> => {
		const pathname = requestPathname(request.url);
		if (pathname === undefined || pathname !== EMBED_BOOTSTRAP_PATH) return false;
		if (request.method === "OPTIONS") {
			respondPreflight(response, request.headers.origin);
			return true;
		}
		if (request.method !== "GET") {
			jsonBody(response, 405, errorEnvelope("METHOD_NOT_ALLOWED", "Method not allowed", "", false));
			return true;
		}
		setEmbedCorsHeaders(response, request.headers.origin);
		const requestId = readRequestId(request);
		response.setHeader("X-Request-Id", requestId);

		try {
			const query = new URL(request.url ?? "/", "http://embed.invalid").searchParams;
			const raw = query.get("publicAppId");
			const publicAppId = raw === null ? null : parsePublicAppId(raw);
			if (publicAppId === null) {
				jsonBody(
					response,
					400,
					errorEnvelope("INVALID_REQUEST", "publicAppId must be a pub_<uuid> locator", requestId, false),
				);
				return true;
			}
			const app = await options.repositories.publishedApps.getByPublicAppId(publicAppId);
			if (app === undefined) {
				jsonBody(response, 404, errorEnvelope("APP_NOT_FOUND", "App is unavailable", requestId, false));
				return true;
			}
			jsonBody(response, 200, { data: await appSummary(options, app), requestId });
			return true;
		} catch (error) {
			options.onError?.(error);
			if (!response.headersSent) {
				jsonBody(response, 500, errorEnvelope("INTERNAL", "Internal server error", requestId, true));
			}
			return true;
		}
	};
}

async function appSummary(
	options: BootstrapHttpHandlerOptions,
	app: PublishedAppRecord,
): Promise<{
	publicAppId: string;
	name: string;
	status: string;
	currentVersionId: string | null;
	features: { uploads: boolean; speech: boolean; avatar: boolean };
	theme: { primaryColor?: string; welcomeMessage?: string };
}> {
	const scope = { tenantId: app.tenantId as TenantId, publishedAppId: app.publishedAppId as PublishedAppId };
	let features = { uploads: false, speech: false, avatar: false };
	if (app.currentVersionId !== null) {
		const version = await options.repositories.publishedAppVersions.get(
			scope,
			app.currentVersionId as PublishedAppVersionId,
		);
		if (version !== undefined) {
			const parsed = parseRuntimeSpec(version.runtimeSpec);
			if (parsed.ok) {
				features = {
					uploads: parsed.spec.capabilities.uploads.enabled,
					speech: parsed.spec.capabilities.speech.enabled,
					avatar: parsed.spec.capabilities.avatar.enabled,
				};
			}
		}
	}
	const policy = (app.mutablePolicy ?? {}) as { theme?: { primaryColor?: string; welcomeMessage?: string } };
	return {
		publicAppId: app.publicAppId,
		name: app.name,
		status: app.status,
		currentVersionId: app.currentVersionId === null ? null : `pav_${app.currentVersionId}`,
		features,
		theme: policy.theme ?? {},
	};
}
