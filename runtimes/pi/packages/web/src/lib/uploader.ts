import type { Attachment } from "@earendil-works/pi-protocol";

export interface UploaderOptions {
	/** HTTP origin of the pi-web backend, e.g. `http://127.0.0.1:8765`. */
	baseUrl: string;
	/** Bearer token sent as `Authorization: Bearer <token>`; omitted when not configured. */
	token?: string;
}

export interface PiUploadClient {
	/** Upload a single file over multipart/form-data and resolve with its attachment record. */
	uploadFile(file: File, onProgress: (fraction: number) => void): Promise<Attachment>;
}

/**
 * Multipart upload client backed by XMLHttpRequest so per-file progress is
 * observable. The upload endpoint lives on the same HTTP server as the
 * WebSocket listener (`/api/pi/v2/uploads`) and requires the WS bearer token.
 */
export function createUploader(options: UploaderOptions): PiUploadClient {
	const { baseUrl, token } = options;
	const url = `${baseUrl}/api/pi/v2/uploads`;

	return {
		uploadFile(file: File, onProgress: (fraction: number) => void): Promise<Attachment> {
			return new Promise<Attachment>((resolve, reject) => {
				const form = new FormData();
				form.append("files", file, file.name);
				const xhr = new XMLHttpRequest();
				xhr.open("POST", url);
				if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) onProgress(event.loaded / event.total);
				};
				xhr.onerror = () => reject(new Error("上传请求失败"));
				xhr.onload = () => {
					if (xhr.status < 200 || xhr.status >= 300) {
						let message = `上传失败（HTTP ${xhr.status}）`;
						try {
							const json = JSON.parse(xhr.responseText) as { error?: { message?: string } };
							if (json.error?.message) message = json.error.message;
						} catch {
							// Fall back to the status-based message.
						}
						reject(new Error(message));
						return;
					}
					try {
						const json = JSON.parse(xhr.responseText) as { attachments?: Attachment[] };
						const attachment = json.attachments?.[0];
						if (!attachment) {
							reject(new Error("服务端未返回附件记录"));
							return;
						}
						resolve(attachment);
					} catch {
						reject(new Error("无法解析服务端响应"));
					}
				};
				xhr.send(form);
			});
		},
	};
}
