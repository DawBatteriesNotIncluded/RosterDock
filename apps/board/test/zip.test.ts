// The zip writer, read back the way an unzip tool reads an archive: the end
// record, then the central directory, then each local header and its data,
// with the CRC-32 and sizes the directory states.
import { randomBytes } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipFiles } from "../src/storage/zip.js";

function readZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBe(zip.length - 22);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer; method: number; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const usize = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.subarray(local + 30, local + 30 + nameLen).toString("utf8")).toBe(name);
    const body = zip.subarray(local + 30 + nameLen, local + 30 + nameLen + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(usize);
    expect(crc32(data) >>> 0).toBe(crc);
    out.push({ name, data, method, flags: zip.readUInt16LE(at + 8) });
    at += 46 + nameLen;
  }
  return out;
}

describe("zip", () => {
  it("holds each file as given, deflated when that is smaller, with UTF-8 names", () => {
    const text = Buffer.from("# Positioning\n\n" + "RosterDock runs on your cluster.\n".repeat(200));
    const noise = randomBytes(512);
    const entries = readZip(
      zipFiles([
        { name: "31-positioning.md", data: text, modified: new Date("2026-09-30T14:37:18Z") },
        { name: "25-faits-clés.md", data: Buffer.from("é\n") },
        { name: "logo.bin", data: noise },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["31-positioning.md", "25-faits-clés.md", "logo.bin"]);
    expect(entries[0]!.data.equals(text)).toBe(true);
    expect(entries[0]!.method).toBe(8);
    // Random bytes do not deflate: stored as they are.
    expect(entries[2]!.method).toBe(0);
    expect(entries[2]!.data.equals(noise)).toBe(true);
    expect(entries.every((e) => (e.flags & 0x0800) !== 0)).toBe(true);
  });

  it("an empty archive is just the end record", () => {
    expect(zipFiles([]).length).toBe(22);
    expect(readZip(zipFiles([]))).toEqual([]);
  });
});
