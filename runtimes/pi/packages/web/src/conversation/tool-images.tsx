import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import { toolImagesFromContent } from "@earendil-works/pi-protocol";
import { useState } from "react";
import "./tool-images.css";

/** Only actual successful tool results produce cards; model prose cannot invent them. */
export function ToolImages({ tools }: { readonly tools: readonly ToolTranscriptItem[] }): React.JSX.Element | null {
	const seen = new Set<string>();
	const images = tools
		.filter((tool) => tool.status === "complete" && !tool.isError)
		.flatMap((tool) =>
			toolImagesFromContent(tool.content).flatMap((image, index) => {
				const key = `${image.mimeType}:${image.data}`;
				if (seen.has(key)) return [];
				seen.add(key);
				return [{ ...image, id: `${tool.toolCallId}-${index}` }];
			}),
		);
	const [expanded, setExpanded] = useState<string | null>(null);
	if (images.length === 0) return null;
	return (
		<section className="tool-images" aria-label="相关图片">
			<span>相关图片</span>
			<div className="tool-images-grid">
				{images.map((image, index) => (
					<figure key={image.id}>
						<button type="button" onClick={() => setExpanded(image.id)} aria-label={`放大图片 ${index + 1}`}>
							<img
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={image.provenance?.title ?? `相关图片 ${index + 1}`}
								loading="lazy"
							/>
						</button>
						{image.provenance?.title || image.provenance?.documentTitle ? (
							<figcaption>
								{image.provenance.title ? <div>{image.provenance.title}</div> : null}
								{image.provenance.documentTitle ? <div>来源：《{image.provenance.documentTitle}》</div> : null}
							</figcaption>
						) : null}
						{expanded === image.id ? (
							<dialog
								className="tool-image-preview"
								aria-label={`图片 ${index + 1}`}
								ref={(dialog) => {
									if (dialog && !dialog.open) dialog.showModal();
								}}
								onCancel={() => setExpanded(null)}
							>
								<button type="button" onClick={() => setExpanded(null)}>
									关闭预览
								</button>
								<img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={image.provenance?.title ?? `相关图片 ${index + 1} 预览`}
								/>
							</dialog>
						) : null}
					</figure>
				))}
			</div>
		</section>
	);
}
