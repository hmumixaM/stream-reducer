const challenge = new TextEncoder().encode("xgoose-litellm-gateway-auth-v1");

/** This gateway has a master key, with no virtual-key database configured. */
export async function validGatewayBearer(header: string | null, masterKey: string): Promise<boolean> {
  const presented = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!presented || presented.length > 512 || !masterKey) return false;
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const suppliedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(presented), algorithm, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", suppliedKey, challenge);
  const expectedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterKey), algorithm, false, ["verify"]);
  return crypto.subtle.verify("HMAC", expectedKey, signature, challenge);
}

/** Preserve LiteLLM's credential-header precedence for its supported SDKs. */
export async function validGatewayAuth(headers: Headers, masterKey: string): Promise<boolean> {
  const custom = headers.get("x-litellm-api-key");
  if (custom) return validGatewayBearer(/^Bearer\s/i.test(custom) ? custom : `Bearer ${custom}`, masterKey);
  const authorization = headers.get("authorization");
  if (authorization) return validGatewayBearer(authorization, masterKey);
  for (const name of ["api-key", "x-api-key", "x-goog-api-key", "ocp-apim-subscription-key"]) {
    const value = headers.get(name);
    if (value !== null) return validGatewayBearer(`Bearer ${value}`, masterKey);
  }
  return false;
}
