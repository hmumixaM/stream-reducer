import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validGatewayBearer, validGatewayAuth } from "../src/auth.ts";

test("accepts the existing gateway bearer and case-insensitive scheme", async () => {
  assert.equal(await validGatewayBearer("Bearer gateway-secret", "gateway-secret"), true);
  assert.equal(await validGatewayBearer("bearer gateway-secret", "gateway-secret"), true);
});

test("rejects absent, malformed, wrong and oversized credentials", async () => {
  for (const header of [null, "", "Basic gateway-secret", "Bearer", "Bearer wrong", "Bearer gateway-secret suffix", "Bearer " + "x".repeat(513)]) {
    assert.equal(await validGatewayBearer(header, "gateway-secret"), false);
  }
  assert.equal(await validGatewayBearer("Bearer anything", ""), false);
});


test("preserves SDK credential headers and rejects a wrong higher-priority credential", async () => {
  for (const name of ["x-litellm-api-key", "api-key", "x-api-key", "x-goog-api-key", "ocp-apim-subscription-key"]) {
    assert.equal(await validGatewayAuth(new Headers({[name]: "sk-test"}), "sk-test"), true);
  }
  assert.equal(await validGatewayAuth(new Headers({authorization: "Bearer wrong", "x-api-key": "sk-test"}), "sk-test"), false);
  assert.equal(await validGatewayAuth(new Headers({"x-litellm-api-key": "wrong", authorization: "Bearer sk-test"}), "sk-test"), false);
  assert.equal(await validGatewayAuth(new Headers(), "sk-test"), false);
});
