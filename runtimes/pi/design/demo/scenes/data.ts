/* 场景共享数据（Q3 增长复盘叙事，取材于 design-reference2.html） */

import type { ChartBar, SourceItemData, TableCellValue } from "../../src";

export const GROWTH_COLUMNS = [
	{ key: "name", label: "分项" },
	{ key: "share", label: "GMV 占比", numeric: true },
	{ key: "yoy", label: "同比", numeric: true },
	{ key: "verdict", label: "判断" }
];

export const GROWTH_ROWS: Array<Record<string, TableCellValue>> = [
	{ name: "老客复购", share: "41.2%", yoy: { value: "+9.6 pt", tone: "positive" }, verdict: { value: "主引擎", tone: "positive" } },
	{ name: "企业版升级", share: "33.5%", yoy: { value: "+6.1 pt", tone: "positive" }, verdict: { value: "健康", tone: "positive" } },
	{ name: "新客首单", share: "18.0%", yoy: { value: "−4.3 pt", tone: "negative" }, verdict: { value: "连续两季下滑", tone: "negative" } },
	{ name: "渠道分销", share: "7.3%", yoy: { value: "+1.0 pt", tone: "positive" }, verdict: "持平" }
];

export const GMV_BARS: ChartBar[] = [
	{ value: 38.1 },
	{ value: 43.9 },
	{ value: 41.5 },
	{ value: 49.8 },
	{ value: 58.6 },
	{ value: 72.4, highlight: true }
];

export const GMV_X_LABELS = ["4月", "5月", "6月", "7月", "8月", "9月"];

export const RAG_SOURCES: SourceItemData[] = [
	{ id: 1, title: "合同审批管理制度（2025 修订版）", meta: "法务部 · 2025/04 · 12 页 · 命中 3 段", type: "知识库" },
	{ id: 2, title: "合同管理 FAQ · 审批权限篇", meta: "法务部 · 命中 2 段", type: "知识库" },
	{ id: 3, title: "合同审批阈值调整纪要 · W16", meta: "共享盘 · xlsx + docx", type: "共享盘" },
	{ id: 4, title: "集团合同管理办法（外部对标）", meta: "外部 · 行业基准", type: "外部", external: true }
];

export const REGION_COLUMNS = [
	{ key: "region", label: "区域" },
	{ key: "gmv", label: "GMV", numeric: true },
	{ key: "newShare", label: "新客占比", numeric: true },
	{ key: "yoy", label: "新客同比", numeric: true },
	{ key: "note", label: "备注" }
];

export const REGION_ROWS: Array<Record<string, TableCellValue>> = [
	{ region: "华东", gmv: "31.2M", newShare: "22.4%", yoy: { value: "−18.2%", tone: "negative" }, note: { value: "显著跑输", tone: "negative" } },
	{ region: "华南", gmv: "24.8M", newShare: "19.1%", yoy: { value: "−4.6%", tone: "negative" }, note: "观察" },
	{ region: "华北", gmv: "18.3M", newShare: "17.8%", yoy: { value: "+2.1%", tone: "positive" }, note: { value: "健康", tone: "positive" } },
	{ region: "西南", gmv: "9.6M", newShare: "15.2%", yoy: { value: "+6.4%", tone: "positive" }, note: { value: "健康", tone: "positive" } }
];

export const REGION_BARS: ChartBar[] = [
	{ value: 31.2, highlight: true },
	{ value: 24.8 },
	{ value: 18.3 },
	{ value: 9.6 }
];

export const REGION_X_LABELS = ["华东", "华南", "华北", "西南"];
