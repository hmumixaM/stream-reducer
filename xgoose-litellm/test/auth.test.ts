import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validGatewayBearer } from "../src/auth.ts";

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
