import { Injectable } from "@nestjs/common";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadEnv } from "../../config/env";

/**
 * S3-compatible object storage (MinIO locally; any S3-compatible provider
 * in production). Documents are NEVER exposed via a permanent public URL —
 * every read goes through a short-lived signed URL generated on demand
 * (§FILE STORAGE: "Never expose a permanent publicly accessible file URL
 * for private user documents").
 */
@Injectable()
export class StorageService {
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

  async signedGetUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const env = loadEnv();
    const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
    return getSignedUrl(this.client(), command, { expiresIn: expiresInSeconds });
  }

  /** DOC-007 "export packet" — the only caller that needs the actual bytes server-side (to add to a ZIP)
   * rather than handing the client a signed URL to fetch directly itself. */
  async getObject(key: string): Promise<Buffer> {
    const env = loadEnv();
    const result = await this.client().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async deleteObject(key: string): Promise<void> {
    const env = loadEnv();
    await this.client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
}
