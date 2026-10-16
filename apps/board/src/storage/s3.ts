// An S3-compatible object store over fetch: AWS Signature Version 4, no SDK.
// PUT and GET of one object, and the bucket created on first use when the
// store answers NoSuchBucket (MinIO in dev; on AWS the operator makes it).
// Credentials come from the environment by name (S3_ACCESS_KEY, S3_SECRET_KEY)
// and never leave this module: they sign, they are not sent.

import { createHash, createHmac } from "node:crypto";

export interface S3Config {
  /** Scheme, host and port of the store, e.g. http://minio:9000 or https://s3.eu-west-1.amazonaws.com. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Path-style addressing (MinIO, Ceph, most self-hosted stores); virtual-hosted otherwise. */
  forcePathStyle: boolean;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** The object's bytes, or null when there is no such key. */
  get(key: string): Promise<Buffer | null>;
}

export interface S3Deps {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 unreserved characters only, as SigV4 wants; `/` kept as the segment separator. */
export function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

const encodeQueryPart = (s: string): string => encodeS3Path(s).replace(/\//g, "%2F");

export interface SignInput {
  method: string;
  /** The host as the request sends it (with the port when it is not the default). */
  host: string;
  /** The request path, already URI-encoded the way S3 wants it (see encodeS3Path); "/" at least. */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign besides host, x-amz-date and x-amz-content-sha256 (which are added). */
  headers?: Record<string, string>;
  payloadHash: string;
  now: Date;
  region: string;
  accessKey: string;
  secretKey: string;
}

/** The headers of a signed S3 request: the caller's, plus host, x-amz-date, x-amz-content-sha256 and authorization. */
export function signS3(input: SignInput): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = input.host;
  headers["x-amz-content-sha256"] = input.payloadHash;
  headers["x-amz-date"] = amzDate;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([k, v]) => [encodeQueryPart(k), encodeQueryPart(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** The S3 error code out of an XML error body, or null. Never the message: it can echo the request. */
function errorCode(body: string): string | null {
  return /<Code>([A-Za-z]+)<\/Code>/.exec(body)?.[1] ?? null;
}

export class ObjectStoreError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(op: string, status: number, code: string | null) {
    super(`object store ${op} answered ${status}${code ? ` (${code})` : ""}`);
    this.status = status;
    this.code = code;
  }
}

export function s3Store(config: S3Config, deps: S3Deps = {}): ObjectStore {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const endpoint = new URL(config.endpoint);
  const host = config.forcePathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const base = endpoint.pathname.replace(/\/+$/, "");
  const bucketPath = config.forcePathStyle ? `${base}/${encodeS3Path(config.bucket)}` : base;

  async function send(
    method: string,
    path: string,
    body: Buffer | null,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Buffer; code: string | null }> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const signed = signS3({
      method,
      host,
      path: path || "/",
      headers,
      payloadHash,
      now: now(),
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    const { host: _host, ...sendHeaders } = signed;
    const res = await fetchImpl(`${endpoint.protocol}//${host}${path || "/"}`, {
      method,
      headers: sendHeaders,
      body: body ?? undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const code = res.ok ? null : errorCode(bytes.toString("utf8"));
    return { status: res.status, body: bytes, code };
  }

  async function createBucket(): Promise<void> {
    // Outside us-east-1, AWS wants the region in the body; MinIO accepts it either way.
    const body =
      config.region === "us-east-1"
        ? null
        : Buffer.from(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${config.region}</LocationConstraint></CreateBucketConfiguration>`,
            "utf8",
          );
    const res = await send("PUT", `${bucketPath}/`, body);
    if (res.status === 200 || res.code === "BucketAlreadyOwnedByYou" || res.code === "BucketAlreadyExists")
      return;
    throw new ObjectStoreError("create bucket", res.status, res.code);
  }

  const objectPath = (key: string) => `${bucketPath}/${encodeS3Path(key)}`;

  return {
    async put(key, body, contentType = "application/octet-stream") {
      const headers = { "content-type": contentType };
      let res = await send("PUT", objectPath(key), body, headers);
      if (res.status === 404 && res.code === "NoSuchBucket") {
        await createBucket();
        res = await send("PUT", objectPath(key), body, headers);
      }
      if (res.status !== 200) throw new ObjectStoreError("put", res.status, res.code);
    },
    async get(key) {
      const res = await send("GET", objectPath(key), null);
      if (res.status === 200) return res.body;
      if (res.status === 404) return null;
      throw new ObjectStoreError("get", res.status, res.code);
    },
  };
}
