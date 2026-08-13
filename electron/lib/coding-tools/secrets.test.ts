import { describe, expect, it } from "vitest";
import { isSecretFile, assertNotSecretFile, bashReferencesSecretFile, assertCommandNotReadingSecrets } from "./secrets";

describe("isSecretFile", () => {
  it("blocks env files and secret-bearing files", () => {
    expect(isSecretFile("/proj/.env")).toBe(true);
    expect(isSecretFile("/proj/.env.local")).toBe(true);
    expect(isSecretFile("/proj/.env.production")).toBe(true);
    expect(isSecretFile("/proj/config/.env.development")).toBe(true);
    expect(isSecretFile("/proj/server.key")).toBe(true);
    expect(isSecretFile("/proj/id_rsa")).toBe(true);
    expect(isSecretFile("/proj/.npmrc")).toBe(true);
    expect(isSecretFile("/proj/.aws/credentials")).toBe(true);
    expect(isSecretFile("/proj/secrets/credentials.json")).toBe(true);
  });

  it("allows env templates, source, and ordinary files", () => {
    expect(isSecretFile("/proj/.env.example")).toBe(false);
    expect(isSecretFile("/proj/.env.sample")).toBe(false);
    expect(isSecretFile("/proj/.env.template")).toBe(false);
    expect(isSecretFile("/proj/src/env.ts")).toBe(false);
    expect(isSecretFile("/proj/README.md")).toBe(false);
    expect(isSecretFile("/proj/.gitignore")).toBe(false);
    expect(isSecretFile("/proj/env/helpers.ts")).toBe(false);
  });
});

describe("assertNotSecretFile", () => {
  it("throws for secret files without echoing the path", () => {
    expect(() => assertNotSecretFile("/proj/.env")).toThrow(/protected/);
    expect(() => assertNotSecretFile("/proj/.env")).not.toThrow(/\/proj\/\.env/);
  });

  it("does not throw for ordinary files", () => {
    expect(() => assertNotSecretFile("/proj/src/main.ts")).not.toThrow();
  });
});

describe("bashReferencesSecretFile", () => {
  it("blocks commands that touch secret files", () => {
    expect(bashReferencesSecretFile("cat .env")).toBe(true);
    expect(bashReferencesSecretFile("grep API_KEY .env.local")).toBe(true);
    expect(bashReferencesSecretFile('cat "$PWD/.env"')).toBe(true);
    expect(bashReferencesSecretFile("cat ~/.npmrc")).toBe(true);
    expect(bashReferencesSecretFile("cat ~/.aws/credentials")).toBe(true);
    expect(bashReferencesSecretFile("cat server.key")).toBe(true);
    expect(bashReferencesSecretFile("sed -n 1,5p .env")).toBe(true);
    expect(bashReferencesSecretFile("source .env && npm start")).toBe(true);
  });

  it("allows env-VARIABLE operations and ordinary commands", () => {
    expect(bashReferencesSecretFile("printenv")).toBe(false);
    expect(bashReferencesSecretFile("env")).toBe(false);
    expect(bashReferencesSecretFile("export NODE_ENV=production")).toBe(false);
    expect(bashReferencesSecretFile("unset FOO")).toBe(false);
    expect(bashReferencesSecretFile("npm test")).toBe(false);
    expect(bashReferencesSecretFile("cat package.json")).toBe(false);
    expect(bashReferencesSecretFile("cat .env.example")).toBe(false);
    expect(bashReferencesSecretFile("git status")).toBe(false);
  });

  it("throws via assertCommandNotReadingSecrets for bash", () => {
    expect(() => assertCommandNotReadingSecrets("cat .env")).toThrow(/protected/);
    expect(() => assertCommandNotReadingSecrets("npm run build")).not.toThrow();
  });
});
