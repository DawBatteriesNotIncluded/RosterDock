// A fake S3-compatible store for tests: replays MinIO's recorded responses
// from fixtures/s3 (status, headers and error bodies), keeps the objects put
// so a GET returns them, and checks each request the way the store would:
// a SigV4 authorization line for the configured key and region, and a
// payload hash that matches the body. global.fetch is never real.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "s3");
interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const fixture = (name: string): Recorded =>
  JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8"));

export interface RecordedS3Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  bytes: number;
}

export interface FakeS3 {
  fetch: typeof fetch;
  requests: RecordedS3Request[];
  /** Buckets that exist; a PUT into another answers NoSuchBucket until the bucket is created. */
  buckets: Set<string>;
  /** Objects by "bucket/key". */
  objects: Map<string, Buffer>;
  /** Fail every call with this status (an outage). */
  failWith: number | null;
}

export function fakeS3(opts: { accessKey: string; region: string; buckets?: string[] }): FakeS3 {
  const s3: FakeS3 = {
    requests: [],
    buckets: new Set(opts.buckets ?? []),
    objects: new Map(),
    failWith: null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
      s3.requests.push({ method, path: url.pathname, headers, bytes: body.byteLength });
      const replay = (name: string, bodyOverride?: Buffer) => {
        const r = fixture(name);
        const h = { ...r.headers };
        delete h["content-length"];
        delete h.connection;
        return new Response(bodyOverride ?? r.body, { status: r.status, headers: h });
      };
      // What a real store checks before anything else.
      const auth = headers.authorization ?? "";
      const shape = new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${opts.accessKey}/\\d{8}/${opts.region}/s3/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$`,
      );
      const m = shape.exec(auth);
      const signed = m?.[1]?.split(";") ?? [];
      const payloadHash = createHash("sha256").update(body).digest("hex");
      if (
        !m ||
        !signed.includes("host") ||
        !signed.includes("x-amz-date") ||
        !signed.includes("x-amz-content-sha256") ||
        !/^\d{8}T\d{6}Z$/.test(headers["x-amz-date"] ?? "") ||
        headers["x-amz-content-sha256"] !== payloadHash ||
        (body.byteLength > 0 && !signed.includes("content-type"))
      ) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code></Error>',
          { status: 403, headers: { "content-type": "application/xml" } },
        );
      }
      if (s3.failWith)
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code></Error>',
          {
            status: s3.failWith,
            headers: { "content-type": "application/xml" },
          },
        );
      // Path-style: /bucket/ creates the bucket, /bucket/key is an object.
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = rest.join("/");
      if (!bucket) return new Response("", { status: 400 });
      if (method === "PUT" && key === "") {
        s3.buckets.add(bucket);
        return replay("create-bucket");
      }
      if (method === "PUT") {
        if (!s3.buckets.has(bucket)) return replay("put-object-no-bucket");
        s3.objects.set(`${bucket}/${key}`, body);
        return replay("put-object");
      }
      if (method === "GET") {
        const found = s3.objects.get(`${bucket}/${key}`);
        if (!found) return replay("get-object-missing");
        return replay("get-object", found);
      }
      return new Response("", { status: 405 });
    }) as typeof fetch,
  };
  return s3;
}
