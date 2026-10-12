import { describe, it, expect } from "vitest";
import { attachmentId, blobFileName, blobsDirName, collisionName, extractEmbedNames, isSha256Hex } from "./attachments";

const H = "a".repeat(64);

describe("extractEmbedNames", () => {
  it("finds embeds with width/anchor aliases and legacy asset:// urls, deduped", () => {
    const body = "![[a.png]] ![[a.png|200]] ![[b.JPG#x]] ![l](asset://c%20d.webp) ![[note]] ![[file.zip]]";
    expect(extractEmbedNames(body).sort()).toEqual(["a.png", "b.JPG", "c d.webp"]);
  });

  it("keeps only the basename of folder-qualified targets", () => {
    expect(extractEmbedNames("![[img/sub/x.png]] ![[..\\evil.png]]").sort()).toEqual(["evil.png", "x.png"]);
  });

  it("handles empty input", () => {
    expect(extractEmbedNames(null)).toEqual([]);
    expect(extractEmbedNames("")).toEqual([]);
  });
});

describe("blob naming", () => {
  it("builds content-addressed names and rejects malformed hashes/exts", () => {
    expect(blobFileName(H, "png")).toBe(`${H}.png`);
    expect(() => blobFileName("../x", "png")).toThrow();
    expect(() => blobFileName(H, "../png")).toThrow();
    expect(isSha256Hex(H)).toBe(true);
    expect(isSha256Hex(H.toUpperCase())).toBe(false);
  });

  it("scopes blob dirs per workspace and rejects unsafe ids", () => {
    expect(blobsDirName("ws-1")).toBe("blobs-ws-1");
    expect(() => blobsDirName("../x")).toThrow();
  });

  it("ids by (hash, name) and suffixes collisions with a short hash", () => {
    expect(attachmentId(H, "a.png")).toBe(`${H}:a.png`);
    expect(collisionName("a.png", H)).toBe("a-aaaaaaaa.png");
  });
});
