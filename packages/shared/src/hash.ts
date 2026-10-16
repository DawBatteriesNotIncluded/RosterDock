// Hash-bound action verification. Pure functions only.
// Ported from agent-board `src/gtm/hash.ts`.
//
// An approved external write is only executable while the payload it was
// approved against is byte-identical (sha256) and the target tool/server and
// intended action still match the approval's ActionBinding. Any drift rejects
// the execution; the caller audits the rejection.

import { createHash } from "node:crypto";

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Deterministic JSON: keys sorted at every level so the same logical payload
 * always hashes the same. Use this for approval bindings.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function payloadSha256(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

export interface ActionBinding {
  artifactId: string;
  sha256: string;
  targetTool: string;
  targetServer: string;
  intendedAction: string;
}

export interface BindingTarget {
  artifactId: string;
  artifactContent: string;
  targetTool: string;
  targetServer: string;
  intendedAction: string;
}

export interface BindingCheck {
  ok: boolean;
  mismatches: string[];
}

export function verifyActionBinding(binding: ActionBinding, actual: BindingTarget): BindingCheck {
  const mismatches: string[] = [];
  if (binding.artifactId !== actual.artifactId) {
    mismatches.push(
      `artifact id mismatch: approval is bound to "${binding.artifactId}", got "${actual.artifactId}"`,
    );
  }
  const actualHash = sha256Hex(actual.artifactContent);
  if (binding.sha256 !== actualHash) {
    mismatches.push(
      `artifact sha256 mismatch: approval is bound to ${binding.sha256}, current content hashes to ${actualHash}`,
    );
  }
  if (binding.targetTool !== actual.targetTool) {
    mismatches.push(
      `target tool mismatch: approval is bound to "${binding.targetTool}", got "${actual.targetTool}"`,
    );
  }
  if (binding.targetServer !== actual.targetServer) {
    mismatches.push(
      `target server mismatch: approval is bound to "${binding.targetServer}", got "${actual.targetServer}"`,
    );
  }
  if (binding.intendedAction !== actual.intendedAction) {
    mismatches.push(
      `intended action mismatch: approval is bound to "${binding.intendedAction}", got "${actual.intendedAction}"`,
    );
  }
  return { ok: mismatches.length === 0, mismatches };
}
