import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, notPublic } from "../src/index.ts";
import { parseConnection } from "../src/kinds.ts";
import { publicFetch } from "../src/public.ts";

test("only an address anyone on the internet could reach is public", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not an address",
  ])
    assert.equal(isPublicAddress(address), false, address);
});

test("a public-only connection is https, to the public internet, with no token", async () => {
  assert.match((await notPublic("http://example.com/")) ?? "", /https/);
  for (const url of [
    "https://localhost/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://10.0.0.1/",
    "https://169.254.169.254/latest",
  ])
    assert.ok(await notPublic(url), url);
  assert.equal(await notPublic("https://1.1.1.1/"), undefined);
  assert.match(
    parseConnection("url", { url: "http://example.com/", public: true }, {}).why ?? "",
    /https/,
  );
  assert.match(
    parseConnection("url", { url: "https://example.com/", public: true }, { token: "t" }).why ?? "",
    /no token/,
  );
  await assert.rejects(publicFetch("https://127.0.0.1/mcp"), /public internet/);
});
