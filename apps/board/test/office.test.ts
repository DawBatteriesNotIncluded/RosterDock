// The office's images: a PNG per sprite mode and per room, in the object
// store under the company, named in the company settings, served back by the
// board. The store is the S3 fake; no network.
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedCompany, startTestBoard, type TestBoard } from "./helpers.js";
import { fakeS3 } from "./s3-fake.js";

const CONFIG = {
  endpoint: "http://minio.test:9000",
  bucket: "rosterdock",
  region: "us-east-1",
  accessKey: "rosterdock",
  secretKey: "rosterdock-test-only",
  forcePathStyle: true,
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
/** A transparent RGBA PNG of the given size, valid for any decoder. */
function png(width: number, height: number, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((1 + width * 4) * height);
  raw[1] = seed; // one pixel differs per seed, so two images hash apart
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let board: TestBoard;
let bare: TestBoard;
let s3: ReturnType<typeof fakeS3>;

beforeAll(async () => {
  s3 = fakeS3({ accessKey: CONFIG.accessKey, region: CONFIG.region, buckets: [CONFIG.bucket] });
  board = await startTestBoard({ storage: CONFIG }, { storageFetch: s3.fetch });
  bare = await startTestBoard();
});
afterAll(async () => {
  await board.destroy();
  await bare.destroy();
});

describe("office images", () => {
  it("keeps a PNG in the store under the company, names it in the settings and serves it back", async () => {
    const { owner, api, companyId, base } = await seedCompany(board, "o1@example.com");
    const sprite = png(48, 24);
    const put = await api.put(`${base}/office/images/sprite.idle`, { content: sprite.toString("base64") });
    expect(put.status).toBe(200);
    const image = put.body.settings.officePack["sprite.idle"];
    expect(image).toMatchObject({ width: 48, height: 24, bytes: sprite.byteLength });
    expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.objects.get(`${CONFIG.bucket}/companies/${companyId}/office/${image.sha256}`)).toEqual(sprite);
    expect(s3.requests.at(-1)?.headers["content-type"]).toBe("image/png");

    const got = await board.app.inject({
      method: "GET",
      url: `${base}/office/images/sprite.idle`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers.etag).toBe(`"${image.sha256}"`);
    expect(got.headers["cache-control"]).toContain("immutable");
    expect(got.rawPayload).toEqual(sprite);

    const events = await api.get(`${base}/events`);
    const ev = events.body.find((e: any) => e.type === "company.updated");
    expect(ev.payload).toEqual({ changes: ["officePack"], image: "sprite.idle" });

    // The same bytes under another name land on the same key; a room floor takes a department id.
    const objects = s3.objects.size;
    expect(
      (await api.put(`${base}/office/images/room.default`, { content: sprite.toString("base64") })).status,
    ).toBe(200);
    expect(s3.objects.size).toBe(objects);
    const pack = (await api.get(base)).body.settings.officePack;
    expect(Object.keys(pack).sort()).toEqual(["room.default", "sprite.idle"]);
  });

  it("refuses what is not an image name, not a PNG, or too big", async () => {
    const { api, base } = await seedCompany(board, "o2@example.com");
    const sprite = png(16, 24);
    expect(
      (await api.put(`${base}/office/images/sprite.walking`, { content: sprite.toString("base64") })).status,
    ).toBe(400);
    expect((await api.put(`${base}/office/images/logo`, { content: sprite.toString("base64") })).status).toBe(
      400,
    );
    const notPng = await api.put(`${base}/office/images/sprite.idle`, {
      content: Buffer.from("GIF89a not a png at all").toString("base64"),
    });
    expect(notPng.status).toBe(400);
    expect(notPng.body.error).toMatch(/PNG/);
    const big = await api.put(`${base}/office/images/sprite.idle`, {
      content: Buffer.concat([sprite, Buffer.alloc(600 * 1024)]).toString("base64"),
    });
    expect(big.status).toBe(413);
    expect((await api.get(base)).body.settings.officePack).toBeUndefined();
  });

  it("is written by owners and admins, read by every member, and never through the company PATCH", async () => {
    const { api, base } = await seedCompany(board, "o3@example.com");
    await api.post(`${base}/members`, { email: "o3-viewer@example.com", role: "viewer" });
    const viewer = board.api((await board.login("o3-viewer@example.com")).token);
    const sprite = png(16, 24, 1);
    const content = sprite.toString("base64");
    expect((await viewer.put(`${base}/office/images/sprite.typing`, { content })).status).toBe(403);
    expect((await api.put(`${base}/office/images/sprite.typing`, { content })).status).toBe(200);
    expect((await viewer.get(`${base}/office/images/sprite.typing`)).status).toBe(200);
    const stranger = board.api((await board.login("o3-stranger@example.com")).token);
    expect((await stranger.get(`${base}/office/images/sprite.typing`)).status).toBe(403);

    const real = (await api.get(base)).body.settings.officePack;
    // A layout edit sends the whole settings object; the pack rides through untouched.
    const layout = await api.patch(base, { settings: { office: { rooms: { none: { slot: 0 } } } } });
    expect(layout.status).toBe(200);
    expect(layout.body.settings.officePack).toEqual(real);
    // A forged entry is ignored: the pack is the routes' to write.
    const forged = await api.patch(base, {
      settings: { officePack: { "sprite.idle": { sha256: "a".repeat(64), width: 1, height: 1, bytes: 1 } } },
    });
    expect(forged.status).toBe(200);
    expect(forged.body.settings.officePack).toEqual(real);
  });

  it("forgets an image on delete and answers 404 for it after", async () => {
    const { api, base } = await seedCompany(board, "o4@example.com");
    const content = png(16, 24, 2).toString("base64");
    await api.put(`${base}/office/images/sprite.reading`, { content });
    await api.put(`${base}/office/images/room.none`, { content });
    const del = await api.del(`${base}/office/images/sprite.reading`);
    expect(del.status).toBe(200);
    expect(Object.keys(del.body.settings.officePack)).toEqual(["room.none"]);
    expect((await api.get(`${base}/office/images/sprite.reading`)).status).toBe(404);
    expect((await api.get(`${base}/office/images/room.none`)).status).toBe(200);
  });

  it("needs an object store and says so without one", async () => {
    const { api, base } = await seedCompany(bare, "o5@example.com");
    const res = await api.put(`${base}/office/images/sprite.idle`, {
      content: png(16, 24).toString("base64"),
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/object store/);
    expect((await api.get(`${base}/office/images/sprite.idle`)).status).toBe(404);
  });
});
