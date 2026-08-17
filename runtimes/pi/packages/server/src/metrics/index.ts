/**
 * Bounded metrics registry (spec 15.1 / TASK-035).
 *
 * MVP metrics: counters, gauges and histograms with a Prometheus-style text
 * exposition. Two guardrails are enforced (禁止继续条件):
 * - **Label allowlist**: a global set of forbidden high-cardinality identity
 *   labels (conversationId / principalId / ...). Registering a metric whose
 *   label set intersects them throws at setup time — identity never becomes an
 *   unbounded label.
 * - **Cardinality cap**: each metric records at most `maxCardinality` distinct
 *   label-value sets; growth past the cap is folded into a single bounded
 *   `overflow` series instead of unbounded memory.
 *
 * The registry is safe to share across the whole embed plane (one instance per
 * process) and holds no identities, only counts (no PII).
 */
export type MetricKind = "counter" | "gauge" | "histogram";

/** Label names that must never be used as metrics labels (high-cardinality). */
export const FORBIDDEN_METRIC_LABELS: ReadonlySet<string> = new Set([
	"conversationId",
	"conversation_id",
	"principalId",
	"principal_id",
	"principal",
	"tokenId",
	"token",
	"visitorId",
	"visitor",
	"subjectHash",
	"externalUserId",
	"external_user_id",
	"user",
]);

export interface MetricSpec {
	readonly name: string;
	readonly help: string;
	/** Allowed label names for this metric (validated against the forbid list). */
	readonly labels?: readonly string[];
	/** Max distinct label-value sets before folding into `overflow`. */
	readonly maxCardinality?: number;
}

export interface HistogramBuckets {
	/** Bucket upper-bounds; `+Inf` is implied and always present. */
	readonly buckets: readonly number[];
}

export type LabelValues = Readonly<Record<string, string>>;

export interface Counter {
	inc(labels?: LabelValues, value?: number): void;
}
export interface Gauge {
	set(value: number, labels?: LabelValues): void;
	add(delta: number, labels?: LabelValues): void;
}
export interface Histogram {
	observe(value: number, labels?: LabelValues): void;
}

export interface MetricSeries {
	readonly labels: LabelValues;
	readonly value: number;
}
export interface MetricsSnapshot {
	readonly kind: MetricKind;
	readonly name: string;
	readonly help: string;
	readonly series: readonly MetricSeries[];
}

export interface MetricRegistry {
	counter(spec: MetricSpec): Counter;
	gauge(spec: MetricSpec): Gauge;
	histogram(spec: MetricSpec & HistogramBuckets): Histogram;
	/** All registered metrics and their live series (no identities). */
	snapshot(): readonly MetricsSnapshot[];
	/** Prometheus text exposition (`# HELP`/`# TYPE` + `name{k="v"} v`). */
	text(): string;
	reset(): void;
}

function normalizeName(name: string): string {
	if (name === "" || !/^[a-z_:][a-z0-9_:]{0,200}$/.test(name)) {
		throw new Error(`invalid metric name: ${JSON.stringify(name)}`);
	}
	return name;
}

function validateSpec(spec: MetricSpec): void {
	for (const label of spec.labels ?? []) {
		if (label === "") {
			throw new Error(`metric "${spec.name}" has an empty label name`);
		}
		if (FORBIDDEN_METRIC_LABELS.has(label)) {
			throw new Error(
				`metric "${spec.name}" uses forbidden high-cardinality label "${label}"; identity must not be a metrics label`,
			);
		}
	}
}

/** Canonical, injective label-set key (sorted JSON) so values may contain any char. */
function labelKey(labels: LabelValues | undefined): string {
	if (labels === undefined) return "";
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(labels).sort()) sorted[key] = labels[key];
	return labelKeyFromObject(sorted);
}

function labelKeyFromObject(sorted: Record<string, string>): string {
	return JSON.stringify(sorted);
}

function labelsFromKey(key: string): LabelValues {
	return key === "" ? {} : (JSON.parse(key) as Record<string, string>);
}

const OVERFLOW_KEY = labelKeyFromObject({ overflow: "true" });

function assertLabelSubset(name: string, allowed: ReadonlySet<string>, labels: LabelValues | undefined): void {
	if (labels === undefined) return;
	for (const key of Object.keys(labels)) {
		if (!allowed.has(key)) {
			throw new Error(`metric "${name}" does not accept label "${key}"`);
		}
	}
}

interface RecordedMetric {
	readonly kind: MetricKind;
	readonly name: string;
	readonly help: string;
	readonly series: Map<string, number>;
	readonly allowed: ReadonlySet<string>;
	readonly maxCardinality: number;
}

function record(metric: RecordedMetric, labels: LabelValues | undefined, value: number, mode: "add" | "set"): void {
	assertLabelSubset(metric.name, metric.allowed, labels);
	const key = labelKey(labels ?? undefined);
	if (key === "" || labels === undefined) {
		if (mode === "set") metric.series.set("", value);
		else metric.series.set("", (metric.series.get("") ?? 0) + value);
		return;
	}
	if (metric.series.has(key)) {
		if (mode === "set") metric.series.set(key, value);
		else metric.series.set(key, metric.series.get(key)! + value);
		return;
	}
	const labeledSlots = metric.series.has("") ? metric.series.size - 1 : metric.series.size;
	if (labeledSlots < metric.maxCardinality) {
		metric.series.set(key, value);
	} else if (mode === "add") {
		// Cardinality exhausted: fold into the single bounded overflow series.
		metric.series.set(OVERFLOW_KEY, (metric.series.get(OVERFLOW_KEY) ?? 0) + value);
	}
}

function seriesEntries(metric: RecordedMetric): MetricSeries[] {
	const out: MetricSeries[] = [];
	for (const [key, value] of metric.series) {
		if (key === "") {
			out.push({ labels: {}, value });
		} else {
			out.push({ labels: labelsFromKey(key), value });
		}
	}
	return out;
}

function seriesLine(name: string, entry: MetricSeries): string {
	const labelPart = Object.keys(entry.labels)
		.sort()
		.map((key) => `${key}="${escapeLabelValue(entry.labels[key])}"`)
		.join(",");
	const suffix = labelPart === "" ? "" : `{${labelPart}}`;
	return `${name}${suffix} ${formatNumber(entry.value)}`;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN";
	return String(value);
}

function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function register(
	metrics: Map<string, RecordedMetric>,
	spec: MetricSpec & { readonly kind: MetricKind },
): RecordedMetric {
	const name = normalizeName(spec.name);
	validateSpec(spec);
	if (metrics.has(name)) throw new Error(`metric "${name}" already registered`);
	const metric: RecordedMetric = {
		kind: spec.kind,
		name,
		help: spec.help,
		series: new Map(),
		allowed: new Set(spec.labels ?? []),
		maxCardinality: spec.maxCardinality ?? 1000,
	};
	metrics.set(name, metric);
	return metric;
}

export function createMetricRegistry(): MetricRegistry {
	const metrics = new Map<string, RecordedMetric>();

	function defineCounter(spec: MetricSpec): Counter {
		const metric = register(metrics, { ...spec, kind: "counter" });
		return {
			inc(labels, value = 1) {
				record(metric, labels, value, "add");
			},
		};
	}
	function defineGauge(spec: MetricSpec): Gauge {
		const metric = register(metrics, { ...spec, kind: "gauge" });
		return {
			set(value, labels) {
				record(metric, labels, value, "set");
			},
			add(delta, labels) {
				record(metric, labels, delta, "add");
			},
		};
	}
	function defineHistogram(spec: MetricSpec & HistogramBuckets): Histogram {
		const buckets = [...spec.buckets].sort((a, b) => a - b);
		const baseLabels = [...(spec.labels ?? []), "le"];
		const bucketCounter = defineCounter({
			name: `${spec.name}_bucket`,
			help: spec.help,
			labels: baseLabels,
			maxCardinality: spec.maxCardinality,
		});
		const sumCounter = defineCounter({ name: `${spec.name}_sum`, help: spec.help, labels: spec.labels });
		const countCounter = defineCounter({ name: `${spec.name}_count`, help: spec.help, labels: spec.labels });
		// Register the histogram itself (kind surfaced in the exposition as
		// `# TYPE name histogram` is optional; default to gauge label-free).
		register(metrics, { ...spec, kind: "histogram" });
		return {
			observe(value, labels) {
				sumCounter.inc(labels, value);
				countCounter.inc(labels, 1);
				// Cumulative buckets (Prometheus semantics): the +Inf bucket is
				// always incremented (= total count) and every upper >= value is.
				bucketCounter.inc({ ...(labels ?? {}), le: "+Inf" });
				for (const upper of buckets) {
					if (value <= upper) bucketCounter.inc({ ...(labels ?? {}), le: String(upper) });
				}
			},
		};
	}

	return {
		counter: defineCounter,
		gauge: defineGauge,
		histogram: defineHistogram,
		snapshot() {
			const out: MetricsSnapshot[] = [];
			for (const metric of metrics.values()) {
				out.push({ kind: metric.kind, name: metric.name, help: metric.help, series: seriesEntries(metric) });
			}
			return out;
		},
		text() {
			const lines: string[] = [];
			for (const metric of metrics.values()) {
				lines.push(`# HELP ${metric.name} ${metric.help.replace(/\n/g, " ")}`);
				lines.push(`# TYPE ${metric.name} ${metric.kind}`);
				for (const entry of seriesEntries(metric)) {
					lines.push(seriesLine(metric.name, entry));
				}
			}
			return lines.join("\n");
		},
		reset() {
			metrics.clear();
		},
	};
}
