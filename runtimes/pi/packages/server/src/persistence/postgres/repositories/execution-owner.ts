import type { OwnerScope } from "../../../publishing/repositories.ts";

/** Only server-owned scope chooses a column. Never interpolate client field names into SQL. */
export function executionOwnerColumn(scope: OwnerScope): "published_app_id" | "integration_id" {
	if (scope.publishedAppId !== null) {
		if (scope.integrationId !== undefined) throw new Error("Mixed execution ownership");
		return "published_app_id";
	}
	if (!scope.integrationId) throw new Error("Missing orchestration ownership");
	return "integration_id";
}

export function executionOwnerId(scope: OwnerScope): string {
	executionOwnerColumn(scope);
	return scope.publishedAppId ?? scope.integrationId!;
}
