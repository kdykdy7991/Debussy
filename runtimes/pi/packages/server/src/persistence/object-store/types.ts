/**
 * Object store contract for attachment storage (spec section 24.1: S3-compatible
 * object storage; local development may use a filesystem implementation).
 *
 * Object keys are always server-generated (spec 26.2: `object_key` is never
 * derived from the client filename). All implementations must be close-safe:
 * after `close()` every operation is rejected.
 */
import type { Readable } from "node:stream";

export interface PutObjectParams {
	readonly bucket: string;
	/** Server-generated object key; must not be derived from user input. */
	readonly objectKey: string;
	readonly data: Buffer | Readable;
	readonly size?: number;
	readonly contentType?: string;
}

export interface ObjectMetadata {
	readonly size: number;
	readonly etag?: string;
	readonly lastModified?: Date;
}

export interface GetObjectParams {
	readonly bucket: string;
	readonly objectKey: string;
}

export interface RemoveObjectParams {
	readonly bucket: string;
	readonly objectKey: string;
}

export interface StatObjectParams {
	readonly bucket: string;
	readonly objectKey: string;
}

export interface ObjectStore {
	putObject(params: PutObjectParams): Promise<void>;
	getObject(params: GetObjectParams): Promise<Buffer>;
	removeObject(params: RemoveObjectParams): Promise<void>;
	statObject(params: StatObjectParams): Promise<ObjectMetadata>;
	close(): Promise<void>;
}
