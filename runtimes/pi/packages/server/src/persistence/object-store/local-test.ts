/**
 * Filesystem-backed object store for local development and tests.
 *
 * Not a production truth source: production must use `S3ObjectStore` (spec
 * 24.1 / WP-01). Object keys are sanitised against path traversal; buckets map
 * to top-level directories under the store root.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
	GetObjectParams,
	ObjectMetadata,
	ObjectStore,
	PutObjectParams,
	RemoveObjectParams,
	StatObjectParams,
} from "./types.ts";

export class LocalTestObjectStore implements ObjectStore {
	private readonly root: string;
	private closed = false;

	constructor(rootDir: string) {
		this.root = resolve(rootDir);
	}

	async putObject(params: PutObjectParams): Promise<void> {
		this.assertOpen();
		const target = this.pathFor(params.bucket, params.objectKey);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, params.data);
	}

	async getObject(params: GetObjectParams): Promise<Buffer> {
		this.assertOpen();
		return readFile(this.pathFor(params.bucket, params.objectKey));
	}

	async removeObject(params: RemoveObjectParams): Promise<void> {
		this.assertOpen();
		await rm(this.pathFor(params.bucket, params.objectKey), { force: true });
	}

	async statObject(params: StatObjectParams): Promise<ObjectMetadata> {
		this.assertOpen();
		const info = await stat(this.pathFor(params.bucket, params.objectKey));
		return { size: info.size, lastModified: info.mtime };
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private pathFor(bucket: string, objectKey: string): string {
		// Server-generated keys must never traverse outside the bucket dir.
		const safeKey = objectKey.replace(/\.\./g, "_").replace(/^\/+/, "");
		return join(this.root, bucket, safeKey);
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("Local object store is closed");
		}
	}
}
