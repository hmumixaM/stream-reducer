import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMermaidSource } from "./mermaidSource.ts";

test("quotes edge labels that contain parentheses", () => {
  const source = 'NodeA["用户客户端 A"] <-->|加密直连 (P2P Mesh)| NodeB["用户客户端 B"]';
  assert.equal(
    normalizeMermaidSource(source),
    'NodeA["用户客户端 A"] <-->|"加密直连 (P2P Mesh)"| NodeB["用户客户端 B"]',
  );
});

test("leaves plain edge labels and already quoted labels alone", () => {
  const source = 'A -->|"step (one)"| B\nB -->|下一步| C';
  assert.equal(normalizeMermaidSource(source), source);
});

test("renames the invalid accessibility directive", () => {
  assert.equal(normalizeMermaidSource("  accDescription: A diagram"), "  accDescr: A diagram");
});
