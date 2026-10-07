import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SecretCipher } from "../src/crypto.js";

describe("Slack token encryption", () => {
  it("round-trips a token without storing plaintext", () => {
    const cipher = new SecretCipher(randomBytes(32).toString("base64"), 3);
    const encrypted = cipher.encrypt("xoxb-sensitive", "A1:-:T1");
    expect(JSON.stringify(encrypted)).not.toContain("xoxb-sensitive");
    expect(cipher.decrypt(encrypted, "A1:-:T1")).toBe("xoxb-sensitive");
  });

  it("binds ciphertext to its installation", () => {
    const cipher = new SecretCipher(randomBytes(32).toString("base64"), 1);
    const encrypted = cipher.encrypt("token", "A1:-:T1");
    expect(() => cipher.decrypt(encrypted, "A1:-:T2")).toThrow();
  });

  it("rejects invalid key material", () => {
    expect(() => new SecretCipher("not-a-32-byte-key", 1)).toThrow(
      /32-byte key/,
    );
  });
});
