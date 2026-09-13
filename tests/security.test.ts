import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, checkOrigin } from "../lib/auth";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

test("public legal pages allow anonymous reading while workspace and API routes remain protected", async () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "production", DEMO_MODE: "false" });
    delete process.env.APP_USER;
    delete process.env.APP_PASSWORD;
    for (const path of [
      "/eula",
      "/privacy-policy",
      "/privacy-policy?source=footer",
      "/api/health",
    ]) {
      const response = await middleware(
        new NextRequest(`https://app.example${path}`),
      );
      assert.equal(response.headers.get("x-middleware-next"), "1", path);
      assert.equal(response.headers.get("www-authenticate"), null);
    }
    assert.equal(
      (await middleware(new NextRequest("https://app.example/api/state")))
        .status,
      503,
    );
    Object.assign(process.env, {
      APP_USER: "operator",
      APP_PASSWORD: "long-random-test-password-only",
    });
    for (const path of [
      "/",
      "/api/state",
      "/api/actions",
      "/api/report",
      "/api/card-mappings/export",
      "/eula/private",
      "/privacy-policy-extra",
    ]) {
      const response = await middleware(
        new NextRequest(`https://app.example${path}`),
      );
      assert.equal(response.status, 401, path);
      assert.ok(response.headers.get("www-authenticate"));
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
test("production requires credentials even when DEMO_MODE is accidentally true", () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      DEMO_MODE: "true",
      APP_USER: "operator",
      APP_PASSWORD: "long-random-test-password-only",
    });
    assert.throws(() =>
      authorize(new Request("https://app.example/api/state")),
    );
    assert.throws(() =>
      authorize(
        new Request("https://app.example/api/state", {
          headers: { "x-middleware-subrequest": "middleware" },
        }),
      ),
    );
    assert.equal(
      authorize(
        new Request("https://app.example/api/state", {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from("operator:long-random-test-password-only").toString(
                "base64",
              ),
          },
        }),
      ),
      "operator",
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
test("origin check uses a configured trust boundary, not Next internal request hostname", () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: "development", DEMO_MODE: "true" });
    delete process.env.APP_ORIGIN;
    assert.doesNotThrow(() =>
      checkOrigin(
        new Request("http://localhost:3000/api/actions", {
          headers: { Origin: "http://127.0.0.1:3000" },
        }),
      ),
    );
    assert.throws(() =>
      checkOrigin(
        new Request("http://127.0.0.1:3000/api/actions", {
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    );
    Object.assign(process.env, {
      NODE_ENV: "production",
      APP_ORIGIN: "https://app.example",
    });
    assert.doesNotThrow(() =>
      checkOrigin(
        new Request("http://internal:3000/api/actions", {
          headers: { Origin: "https://app.example" },
        }),
      ),
    );
    assert.throws(() =>
      checkOrigin(new Request("https://app.example/api/actions")),
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
