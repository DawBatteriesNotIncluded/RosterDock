// The file store: one JSON file per secret in a directory only the board
// reads, written whole and renamed into place, mode 0600. For dev and docker
// compose, where there is no cluster; a production board uses the cluster's
// Secrets (kubernetes.ts).
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSecretName, type SecretData, type SecretStore } from "./store.js";

export function fileSecretStore(dir: string): SecretStore {
  const fileOf = (name: string) => path.join(dir, `${assertSecretName(name)}.json`);
  return {
    kind: "file",
    async get(name) {
      try {
        const text = await readFile(fileOf(name), "utf8");
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const out: SecretData = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
          if (typeof v === "string") out[k] = v;
        return out;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async put(name, data) {
      const file = fileOf(name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await rename(tmp, file);
    },
    async delete(name) {
      await rm(fileOf(name), { force: true });
    },
  };
}
