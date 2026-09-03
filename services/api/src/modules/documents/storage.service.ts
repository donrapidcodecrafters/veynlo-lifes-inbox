import { Injectable } from "@nestjs/common";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadEnv } from "../../config/env";
import type { ObjectStorage } from "./object-storage.interface";

/**
 * S3-compatible object storage (MinIO locally; any S3-compatible provider
 * in production). Documents are NEVER exposed via a permanent public URL —
 * every read goes through a short-lived signed URL generated on demand
 * (§FILE STORAGE: "Never expose a permanent publicly accessible file URL
 * for private user documents").
 */
@Injectable()
export class StorageService implements ObjectStorage {
  private client(): S3Client {
    const env = loadEnv();
    return new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const env = loadEnv();
    await this.client().send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const env = loadEnv();
    const response = await this.client().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    // AWS SDK v3's Body is a Node Readable in this runtime (not a browser ReadableStream/Blob) — the SDK
    // types it as a union across environments, but this app only ever runs under Node.
    for await (const chunk of response.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async signedGetUrl(key: string, expiresInSeconds = 300, downloadFilename?: string): Promise<string> {
    const env = loadEnv();
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ...(downloadFilename ? { ResponseContentDisposition: `attachment; filename="${downloadFilename.replace(/"/g, "")}"` } : {}),
    });
    return getSignedUrl(this.client(), command, { expiresIn: expiresInSeconds });
  }

  async deleteObject(key: string): Promise<void> {
    const env = loadEnv();
    await this.client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
}
