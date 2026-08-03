import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, "actor-manifest.jsonld"), "utf-8"));

describe("Insatsu actor manifest", () => {
  it("has canonical DID and nanoid", () => {
    expect(manifest["@id"]).toBe("did:web:insatsu.etzhayyim.com");
    expect(manifest.nanoid).toBe("ins4tup1");
  });

  it("publishes expected actor paths", () => {
    const paths = manifest.actors.map((actor: { path: string }) => actor.path);
    expect(paths).toContain("network:broker");
    expect(paths).toContain("partner");
    expect(paths).toContain("lane:postal");
    expect(paths).toContain("lane:hybrid");
  });
});
