import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  at,
  bundleApp,
  SEPARATOR,
  scriptPackages,
  stylesheetPackages,
  thirdPartyLicenses,
} from "../scripts/bundle.js";

test("the built THIRD_PARTY_LICENSES.txt has a section, with its licence text, for each npm package the script and the stylesheet take in", async () => {
  // The script bundled again, unwritten: what is in it now.
  const { metafile } = await bundleApp({ write: false });
  const folders = new Set([...scriptPackages(metafile), ...stylesheetPackages()]);
  assert.ok(folders.size > 100, `only ${folders.size} packages found in the bundle`);
  const built = readFileSync(at("dist/THIRD_PARTY_LICENSES.txt"), "utf8");
  const heads = built.split(SEPARATOR).map((section) => section.split("\n")[0] ?? "");
  for (const folder of folders) {
    const { name, version } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    assert.ok(
      heads.some((head) => head.startsWith(`${name} ${version} (`)),
      `${name} ${version} is bundled with no section`,
    );
  }
  // Each section holds a licence text: Apache-2.0's in full, any other with the line naming who holds
  // the copyright, not only the licence's words about "the above copyright notice". And the file is
  // the one this bundle makes: a package with no licence text refuses here, and a section of one no
  // longer bundled fails the comparison.
  const holder = /copyright\s*(?:\(c\)|©|\d{4})|^\s*copyright\s+(?!notice|holder)\S/im;
  for (const section of built.split(SEPARATOR)) {
    const [head = "", ...text] = section.split("\n");
    if (head.endsWith("(Apache-2.0)"))
      assert.match(text.join("\n"), /TERMS AND CONDITIONS/, `${head}: not the licence in full`);
    else assert.match(text.join("\n"), holder, `${head}: no copyright holder`);
  }
  assert.equal(built, thirdPartyLicenses(folders));
});
