/**
 * S3-compatible object store adapter backed by the `minio` client.
 *
 * The `minio` client has no explicit shutdown; `close()` marks the adapter
 * closed and drops the reference so no further operations are accepted.
 */
import { Client } from "minio";
import type {
	GetObjectParams,
	ObjectMetadata,
	ObjectStore,
	PutObjectParams,
	RemoveObjectParams,
	StatObjectParams,
} from "./types.ts";

export interface S3ObjectStoreOptions {
	/** S3 endpoint host, e.g. `s3.amazonaws.com` or `127.0.0.1` for MinIO. */
	readonly endPoint: string;
	readonly port?: number;
	/** Defaults to false (plain HTTP); production must set true. */
	readonly useSSL?: boolean;
	readonly accessKey: string;
	readonly secretKey: string;
	readonly region?: string;
	/** Bucket name used for every operation. */
	readonly bucket: string;
}

export class S3ObjectStore implements ObjectStore {
	private readonly client: Client;
	private readonly bucket: string;
	private closed = false;

	constructor(options: S3ObjectStoreOptions) {
		if (options.accessKey === "" || options.secretKey === "") {
			throw new Error("S3 object store requires non-empty accessKey and secretKey");
		}
		if (options.bucket === "") {
			throw new Error("S3 object store requires a non-empty bucket");
		}
		this.client = new Client({
			endPoint: options.endPoint,
			port: options.port,
			useSSL: options.useSSL ?? false,
			accessKey: options.accessKey,
			secretKey: options.secretKey,
			region: options.region,
		});
		this.bucket = options.bucket;
	}

	async putObject(params: PutObjectParams): Promise<void> {
		this.assertOpen();
		const meta = params.contentType !== undefined ? { "Content-Type": params.contentType } : undefined;
		await this.client.putObject(this.bucket, params.objectKey, params.data, params.size, meta);
	}

	async getObject(params: GetObjectParams): Promise<Buffer> {
		this.assertOpen();
		const stream = await this.client.getObject(this.bucket, params.objectKey);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	}

	async removeObject(params: RemoveObjectParams): Promise<void> {
		this.assertOpen();
		await this.client.removeObject(this.bucket, params.objectKey);
	}

	async statObject(params: StatObjectParams): Promise<ObjectMetadata> {
		this.assertOpen();
		const stat = await this.client.statObject(this.bucket, params.objectKey);
		return {
			size: stat.size,
			etag: stat.etag,
			lastModified: stat.lastModified,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("S3 object store is closed");
		}
	}
}
