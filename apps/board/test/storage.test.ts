// Object storage for artifacts over the inline limit: the SigV4 signer against
// the AWS worked examples, the store against MinIO's recorded responses, and
// the board spilling a large diff to the bucket and reading it back for the
// review and the reviewer's run. No network: the fake replays fixtures/s3.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_SHA256, ObjectStoreError, s3Store, signS3 } from "../src/storage/s3.js";
import { addProject, addTeammate, seedCompany, startTestBoard, type Api, type TestBoard } from "./helpers.js";
import { fakeS3 } from "./s3-fake.js";

// The two examples in the AWS documentation (Signature Version 4, S3): known keys, known date, known signatures.
const EXAMPLE = {
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  now: new Date("2013-05-24T00:00:00Z"),
};

describe("SigV4 for S3", () => {
  it("signs the documented GET Object example", () => {
    const h = signS3({
      ...EXAMPLE,
      method: "GET",
      path: "/test.txt",
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
    });
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs the documented PUT Object example, with the path encoded the S3 way", () => {
    const h = signS3({
      ...EXAMPLE,
      method: "PUT",
      path: "/test%24file.text",
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: createHash("sha256").update("Welcome to Amazon S3.").digest("hex"),
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
});

const CONFIG = {
  endpoint: "http://minio.test:9000",
  bucket: "rosterdock",
  region: "us-east-1",
  accessKey: "rosterdock",
  secretKey: "rosterdock-test-only",
  forcePathStyle: true,
};

describe("the store", () => {
  it("creates the bucket on first use, puts, gets, and answers null for a key that is not there", async () => {
    const s3 = fakeS3({ accessKey: CONFIG.accessKey, region: CONFIG.region });
    const store = s3Store(CONFIG, { fetch: s3.fetch });
    const body = Buffer.from("x".repeat(600 * 1024), "utf8");
    await store.put("companies/c1/runs/r1/abc", body, "text/plain; charset=utf-8");
    expect(s3.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /rosterdock/companies/c1/runs/r1/abc",
      "PUT /rosterdock/",
      "PUT /rosterdock/companies/c1/runs/r1/abc",
    ]);
    expect(s3.requests[2]!.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(s3.requests[2]!.bytes).toBe(body.byteLength);
    expect(s3.buckets.has("rosterdock")).toBe(true);
    const back = await store.get("companies/c1/runs/r1/abc");
    expect(back?.equals(body)).toBe(true);
    expect(await store.get("companies/c1/runs/r1/none")).toBeNull();
    // A second put goes straight in.
    await store.put("companies/c1/runs/r1/def", Buffer.from("y"), "text/plain");
    expect(s3.requests).toHaveLength(6);
  });

  it("addresses a virtual-hosted bucket by host and encodes the key", async () => {
    const s3 = fakeS3({ accessKey: "AKIA", region: "eu-west-1", buckets: ["rosterdock-prod"] });
    const seen: string[] = [];
    const store = s3Store(
      {
        ...CONFIG,
        endpoint: "https://s3.eu-west-1.amazonaws.com",
        bucket: "rosterdock-prod",
        region: "eu-west-1",
        accessKey: "AKIA",
        forcePathStyle: false,
      },
      {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          seen.push(String(input));
          // The fake is path-style; rewrite so it finds the bucket in the path.
          const u = new URL(String(input));
          return s3.fetch(`http://minio.test${"/rosterdock-prod"}${u.pathname}`, init);
        }) as typeof fetch,
      },
    );
    await store.put("companies/c1/runs/r1/a b+c", Buffer.from("z"), "text/plain");
    expect(seen[0]).toBe("https://rosterdock-prod.s3.eu-west-1.amazonaws.com/companies/c1/runs/r1/a%20b%2Bc");
    expect(s3.requests[0]!.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/eu-west-1\/s3\/aws4_request, /,
    );
  });

  it("surfaces an outage as an error with the status and code, never the body", async () => {
    const s3 = fakeS3({ accessKey: CONFIG.accessKey, region: CONFIG.region, buckets: ["rosterdock"] });
    s3.failWith = 503;
    const store = s3Store(CONFIG, { fetch: s3.fetch });
    const err = await store.put("k", Buffer.from("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ObjectStoreError);
    expect((err as ObjectStoreError).status).toBe(503);
    expect((err as ObjectStoreError).message).toBe("object store put answered 503 (InternalError)");
    await expect(store.get("k")).rejects.toThrow(/answered 503/);
  });

  it("is refused by a store that checks signatures when the key is wrong", async () => {
    const s3 = fakeS3({ accessKey: "someone-else", region: CONFIG.region, buckets: ["rosterdock"] });
    const store = s3Store(CONFIG, { fetch: s3.fetch });
    const err = await store.put("k", Buffer.from("x")).catch((e: unknown) => e as ObjectStoreError);
    expect((err as ObjectStoreError).code).toBe("SignatureDoesNotMatch");
  });
});

// A unified diff adding one file of many rows: over the inline limit, under the store's cap.
function bigDiff(rows: number): string {
  const lines = Array.from({ length: rows }, (_, i) => `+row ${i}: ${"x".repeat(20)}`).join("\n");
  return `diff --git a/big.csv b/big.csv\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/big.csv\n@@ -0,0 +1,${rows} @@\n${lines}\n`;
}

describe("artifacts over the inline limit", () => {
  let withStore: TestBoard;
  let without: TestBoard;
  let s3: ReturnType<typeof fakeS3>;

  beforeAll(async () => {
    // The bucket exists, as on a real install; the store test covers making it.
    s3 = fakeS3({ accessKey: CONFIG.accessKey, region: CONFIG.region, buckets: [CONFIG.bucket] });
    withStore = await startTestBoard({ storage: CONFIG }, { storageFetch: s3.fetch });
    without = await startTestBoard();
  });
  afterAll(async () => {
    await withStore.destroy();
    await without.destroy();
  });

  async function setup(board: TestBoard, email: string) {
    const c = await seedCompany(board, email);
    const cody = await addTeammate(c.api, c.base, "Cody");
    await addTeammate(c.api, c.base, "Verifier", "reviewer");
    const project = await addProject(c.api, c.base);
    const task = (
      await c.api.post(`${c.base}/tasks`, {
        projectId: project.id,
        title: "Export the account list",
        assignee: { kind: "teammate", id: cody.id },
        declaredOutputs: ["big.csv"],
      })
    ).body;
    const run = (await c.api.post(`${c.base}/tasks/${task.id}/runs`, {})).body;
    const jobId =
      (await board.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [run.id]))
        .rows[0]?.job_id ?? "00000000-0000-4000-8000-000000000000";
    const claimed = await board.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId: run.id, jobId, workerId: "worker-1" },
    });
    const claim = JSON.parse(claimed.body);
    return { ...c, task, run, claim, asRun: board.api(claim.token) as Api };
  }

  it("a 700 KB diff goes to the bucket under the company and run, reads back, and opens the review from it", async () => {
    const { api, base, task, run, claim, asRun } = await setup(withStore, "s1@example.com");
    expect(claim.spec.limits).toEqual({ artifactBytes: 8 * 1024 * 1024 });
    const diff = bigDiff(24_000);
    expect(Buffer.byteLength(diff)).toBeGreaterThan(512 * 1024);
    const before = s3.requests.length;
    const art = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: diff,
    });
    expect(art.status).toBe(201);
    expect(art.body.inline).toBe(false);
    expect(art.body.bytes).toBe(Buffer.byteLength(diff));
    const sha = createHash("sha256").update(diff).digest("hex");
    expect(art.body.sha256).toBe(sha);
    const puts = s3.requests.slice(before).filter((r) => r.method === "PUT" && r.path !== "/rosterdock/");
    const companyId = base.split("/").pop()!;
    expect(puts.map((p) => p.path)).toEqual([`/rosterdock/companies/${companyId}/runs/${run.id}/${sha}`]);
    const row = (
      await withStore.db.query<{ content: string | null; object_key: string | null }>(
        "SELECT content, object_key FROM artifacts WHERE id = $1",
        [art.body.id],
      )
    ).rows[0]!;
    expect(row.content).toBeNull();
    expect(row.object_key).toBe(`companies/${companyId}/runs/${run.id}/${sha}`);

    // A small one still lives in its row.
    const small = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "big.csv",
      kind: "file",
      content: "row 0\n",
    });
    expect(small.body.inline).toBe(true);

    // The company reads the large one through the API, from the bucket.
    const read = (await api.get(`${base}/runs/${run.id}/artifacts/${art.body.id}`)).body;
    expect(read.inline).toBe(false);
    expect(read.content).toBe(diff);

    // The run completes: the review opens with the file parsed out of the stored diff.
    const done = await asRun.post(`/api/worker/runs/${run.id}/complete`, {
      status: "completed",
      summary: "Exported the accounts.",
      usage: { inputTokens: 1000, outputTokens: 100 },
      durationMs: 1000,
    });
    expect(done.status).toBe(200);
    const review = (await api.get(`${base}/tasks/${task.id}/review`)).body;
    expect(review.status).toBe("open");
    expect(review.files).toHaveLength(1);
    expect(review.files[0].path).toBe("big.csv");
    expect(review.files[0].additions).toBe(24_000);

    // The reviewer's run carries the diff in its spec, read from the bucket.
    const runs = (await api.get(`${base}/tasks/${task.id}/runs`)).body as { id: string; kind: string }[];
    const reviewRun = runs.find((r) => r.kind === "review");
    expect(reviewRun).toBeDefined();
    const jobId = (
      await withStore.db.query<{ job_id: string | null }>("SELECT job_id FROM runs WHERE id = $1", [
        reviewRun!.id,
      ])
    ).rows[0]!.job_id;
    const claimed = await withStore.app.inject({
      method: "POST",
      url: "/api/worker/claim",
      headers: { "x-rosterdock-worker-token": "test-worker-token" },
      payload: { runId: reviewRun!.id, jobId, workerId: "worker-2" },
    });
    expect(claimed.statusCode).toBe(201);
    const spec = JSON.parse(claimed.body).spec;
    expect(spec.review.diff).toContain("+row 0: ");
    expect(spec.review.files[0].additions).toBe(24_000);
  });

  it("without an object store the board refuses an artifact over 512 KB and says why; the spec says so too", async () => {
    const { run, claim, asRun } = await setup(without, "s2@example.com");
    expect(claim.spec.limits).toEqual({ artifactBytes: 512 * 1024 });
    const res = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "changes.diff",
      kind: "diff",
      content: bigDiff(24_000),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/no object store is configured/);
  });

  it("refuses an artifact over the store's cap", async () => {
    const { run, asRun } = await setup(withStore, "s3@example.com");
    const res = await asRun.post(`/api/worker/runs/${run.id}/artifacts`, {
      path: "huge.csv",
      content: "x".repeat(8 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/the limit is 8388608/);
  });
});
