/**
 * M1 R8 脱型测试：会话固定 PublishedAppVersion capability。
 *
 * **本测试是占位（placeholder）**——后端只读契约待架构师确认（详见
 * `docs/development/agent-platform-v2/evidence/m1-r8-blocker2.md`）。FE
 * 在契约冻结前**不**自行扩展 DTO（`reasoning-tab.tsx` 顶部 TODO）。
 *
 * 接入步骤（架构师确认契约后）：
 *
 *   1. 在 `packages/protocol/src/admin-workbench-reasoning.ts` 增加
 *      `ConversationPinnedCapabilityResponse` 类型 + 端点常量
 *      `AGENT_V2_REASONING_CAPABILITY_PATH`。
 *   2. `ConversationsApi.getCapability(conversationId, signal?)` 走
 *      `GET /api/control/v1/conversations/{id}/capability`。
 *   3. `ReasoningTab` 接入 capability 加载：`stateGuard` 守护 `getReasoning`，
 *      新增独立 `capabilityGuard` 守护 `getCapability`，互不取消。
 *   4. 取消 `it.skip(...)` 并启用以下 case（替换占位）：
 *      - v1 会话在 Agent 发 v2 后仍显示 v1 effort 档位（getCapability
 *        返回的是 v1 的 parameterCapabilities）；
 *      - capability load 与 state load 互不取消（两个 guard 独立）；
 *      - 切换 conversation 后旧会话的 capability 响应不覆盖新会话。
 *
 * 当前所有 case 都被 `it.skip` 跳过——它们**不**会跑，也不会失败。
 */
import { describe, it } from "vitest";

describe("M1 R8 pinned capability (placeholder, BE contract pending)", () => {
	it.skip("v1 会话在 Agent 发 v2 后仍显示 v1 effort 档位（待 BE 契约）", () => {
		// 占位：BE 契约冻结后填真实测试。
	});

	it.skip("capability load 与 state load 互不取消（待 BE 契约）", () => {
		// 占位：BE 契约冻结后填真实测试。
	});

	it.skip("切换 conversation 后旧 capability 响应不覆盖新会话（待 BE 契约）", () => {
		// 占位：BE 契约冻结后填真实测试。
	});
});
