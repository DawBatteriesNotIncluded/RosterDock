// Record an S3-compatible store's responses to the object store's calls as the
// fixtures in test/fixtures/s3, against a throwaway bucket, with the store's own
// client. Usage, from apps/board with the S3_* env of .env (MinIO from pnpm db:up):
//   node --env-file=.env --import tsx scripts/record-s3-fixtures.mts
// Checks the signer against the AWS worked examples first; refuses to write
// fixtures if those do not match.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_SHA256, s3Store, signS3 } from "../src/storage/s3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "test", "fixtures", "s3");

const example = {
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  now: new Date("2013-05-24T00:00:00Z"),
};
const get = signS3({
  ...example,
  method: "GET",
  path: "/test.txt",
  headers: { range: "bytes=0-9" },
  payloadHash: EMPTY_SHA256,
});
const put = signS3({
  ...example,
  method: "PUT",
  path: "/test%24file.text",
  headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
  payloadHash: createHash("sha256").update("Welcome to Amazon S3.").digest("hex"),
});
if (
  !get.authorization!.endsWith("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41") ||
  !put.authorization!.endsWith("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")
) {
  console.error("the signer does not match the AWS examples; not recording");
  process.exit(1);
}

const calls: {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const buf = Buffer.from(await res.arrayBuffer());
  const url = new URL(String(input));
  calls.push({
    method: init?.method ?? "GET",
    path: url.pathname,
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: buf.toString("utf8"),
  });
  return new Response(buf, { status: res.status, headers: res.headers });
};
const bucket = `rosterdock-fixtures-${randomBytes(3).toString("hex")}`;
const cfg = {
  endpoint: process.env.S3_ENDPOINT!,
  bucket,
  region: process.env.S3_REGION ?? "us-east-1",
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "0",
};
const store = s3Store(cfg, { fetch: recordingFetch });
const key = "companies/8f1e0f6e-0000-4000-8000-000000000001/runs/1b2c3d4e-0000-4000-8000-000000000002/abc123";
const body = Buffer.from("x".repeat(600 * 1024), "utf8");
await store.put(key, body, "text/plain; charset=utf-8");
const back = await store.get(key);
if (!back?.equals(body)) throw new Error("the object did not come back as put");
if ((await store.get("companies/none/runs/none/none")) !== null) throw new Error("a missing key answered");
// Clean up with signed DELETEs; the store itself never deletes.
const endpoint = new URL(cfg.endpoint);
for (const p of [`/${bucket}/${key}`, `/${bucket}/`]) {
  const signed = signS3({
    method: "DELETE",
    host: endpoint.host,
    path: p,
    payloadHash: EMPTY_SHA256,
    now: new Date(),
    region: cfg.region,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
  });
  const { host: _host, ...headers } = signed;
  await fetch(`${endpoint.protocol}//${endpoint.host}${p}`, { method: "DELETE", headers });
}
const names = ["put-object-no-bucket", "create-bucket", "put-object", "get-object", "get-object-missing"];
if (calls.length !== names.length) throw new Error(`expected ${names.length} calls, saw ${calls.length}`);
mkdirSync(out, { recursive: true });
calls.forEach((c, i) => {
  // The 600 KB body is not a fixture; the fake serves what was put.
  const record = { ...c, body: c.method === "GET" && c.status === 200 ? "<the object's bytes>" : c.body };
  writeFileSync(path.join(out, `${names[i]}.json`), JSON.stringify(record, null, 2) + "\n");
  console.log(names[i], c.method, c.status);
});
