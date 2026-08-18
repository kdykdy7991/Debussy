import { AnalysisScene } from "./scenes/analysis-scene";
import { ArtifactScene } from "./scenes/artifact-scene";
import { ComposerScene } from "./scenes/composer-scene";
import { ConversationScene } from "./scenes/conversation-scene";
import { RagScene } from "./scenes/rag-scene";
import { RunningScene } from "./scenes/running-scene";
import { TraceScenes } from "./scenes/trace-scenes";

/** 组件验证 demo —— 不接入生产 Chat，不修改正式页面。 */
export function DemoApp() {
	return (
		<div className="dm-page">
			<header className="dm-masthead">
				<div className="dm-masthead-eyebrow">Component Kit · Dev Demo</div>
				<h1 className="dm-masthead-title">AI UI Kit</h1>
				<div className="dm-masthead-sub">
					<b>10</b> 个语义组件 · <b>6</b> 个 motion primitive · 规范来源 docs/ui-patterns/ · 颜色为占位主题
				</div>
			</header>

			<ConversationScene />
			<RunningScene />
			<TraceScenes />
			<RagScene />
			<AnalysisScene />
			<ArtifactScene />
			<ComposerScene />
		</div>
	);
}
