import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { detectAuth, type AuthProbeDeps } from "./index.js";

function makeDeps(over: Partial<AuthProbeDeps> = {}): AuthProbeDeps {
  return {
    platform: "linux",
    env: {},
    homedir: () => "/home/test",
    fileExistsNonEmpty: async () => false,
    keychainHasClaudeEntry: async () => false,
    ...over,
  };
}

test("macOS, keychain entry present, no env, no files → authed", async () => {
  let keychainCalls = 0;
  const res = await detectAuth(
    makeDeps({
      platform: "darwin",
      keychainHasClaudeEntry: async () => {
        keychainCalls++;
        return true;
      },
    }),
  );
  assert.equal(res.authed, true);
  assert.equal(res.hint, undefined);
  assert.equal(keychainCalls, 1);
});

test("macOS, no keychain, no env, no files → not authed with macOS hint", async () => {
  const res = await detectAuth(
    makeDeps({
      platform: "darwin",
      keychainHasClaudeEntry: async () => false,
      fileExistsNonEmpty: async () => false,
    }),
  );
  assert.equal(res.authed, false);
  assert.match(res.hint ?? "", /macOS Keychain/);
  assert.match(res.hint ?? "", /claude \/login/);
});

test("Linux, no env, no files → not authed with file-based hint", async () => {
  const res = await detectAuth(
    makeDeps({
      platform: "linux",
      fileExistsNonEmpty: async () => false,
    }),
  );
  assert.equal(res.authed, false);
  assert.match(res.hint ?? "", /no credentials in .*\.claude/);
  assert.match(res.hint ?? "", /ANTHROPIC_AUTH_TOKEN/);
});

test("ANTHROPIC_API_KEY set → authed regardless of platform", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const res = await detectAuth(
      makeDeps({
        platform,
        env: { ANTHROPIC_API_KEY: "sk-ant-xyz" },
        // intentionally fail every other check to prove env wins:
        keychainHasClaudeEntry: async () => {
          throw new Error("should not be called");
        },
        fileExistsNonEmpty: async () => {
          throw new Error("should not be called");
        },
      }),
    );
    assert.equal(res.authed, true, `platform=${platform}`);
    assert.equal(res.hint, undefined);
  }
});

test("CLAUDE_CODE_OAUTH_TOKEN set → authed regardless of platform", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const res = await detectAuth(
      makeDeps({
        platform,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-..." },
        keychainHasClaudeEntry: async () => {
          throw new Error("should not be called");
        },
        fileExistsNonEmpty: async () => {
          throw new Error("should not be called");
        },
      }),
    );
    assert.equal(res.authed, true, `platform=${platform}`);
  }
});

test("ANTHROPIC_AUTH_TOKEN takes precedence (existing behavior preserved)", async () => {
  const res = await detectAuth(
    makeDeps({
      platform: "darwin",
      env: { ANTHROPIC_AUTH_TOKEN: "tok" },
      keychainHasClaudeEntry: async () => {
        throw new Error("should not be called");
      },
    }),
  );
  assert.equal(res.authed, true);
});

test("macOS keychain probe failure falls through to file-based check (does not crash)", async () => {
  const res = await detectAuth(
    makeDeps({
      platform: "darwin",
      keychainHasClaudeEntry: async () => {
        throw new Error("spawn ENOENT");
      },
      fileExistsNonEmpty: async (file) =>
        file === path.join("/home/test", ".claude", ".credentials.json"),
    }),
  );
  assert.equal(res.authed, true);
});

test("Linux, credentials.json present → authed", async () => {
  const res = await detectAuth(
    makeDeps({
      platform: "linux",
      fileExistsNonEmpty: async (file) => file.endsWith(".credentials.json"),
    }),
  );
  assert.equal(res.authed, true);
});

test("CLAUDE_CONFIG_DIR overrides default config dir", async () => {
  const seen: string[] = [];
  const res = await detectAuth(
    makeDeps({
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: "/custom/dir" },
      fileExistsNonEmpty: async (file) => {
        seen.push(file);
        return false;
      },
    }),
  );
  assert.equal(res.authed, false);
  assert.ok(seen.every((f) => f.startsWith("/custom/dir")), `seen=${JSON.stringify(seen)}`);
  assert.match(res.hint ?? "", /\/custom\/dir/);
});
