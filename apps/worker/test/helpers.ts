// Shared by the worker's tests.
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "vitest";

/**
 * Skips the test where the OS refuses to create a symbolic link: Windows makes one only for an
 * administrator or with Developer Mode on. Everywhere else a refusal fails the test.
 */
export async function skipWithoutSymlinks(ctx: TestContext, dir: string): Promise<void> {
  const probe = path.join(dir, `symlink-probe-${process.pid}`);
  try {
    await symlink("target", probe);
  } catch (err) {
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM")
      ctx.skip("Windows refused to create a symbolic link: that takes Developer Mode or an administrator");
    throw err;
  }
  await rm(probe);
}
