/** Private, preconfigured Provider identities supplied by the server administrator. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ProviderIdentity, providers } from "../domain/providers.ts";
import { readPrivate } from "../home.ts";

/** Enrollment is explicit; an absent file admits no Providers. */
export function loadProviders(directory: string): ProviderIdentity[] {
  const path = join(directory, "providers.json");
  if (!existsSync(path)) return [];
  try {
    const configured: unknown = JSON.parse(readPrivate(path));
    if (
      !Array.isArray(configured) ||
      configured.some(
        (entry: unknown) =>
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          Object.keys(entry).length !== 2 ||
          !("providerId" in entry) ||
          typeof entry.providerId !== "string" ||
          !("credentialHash" in entry) ||
          typeof entry.credentialHash !== "string",
      )
    ) {
      throw new Error();
    }
    const identities = configured as ProviderIdentity[];
    providers(identities);
    return identities;
  } catch {
    throw new Error(
      "providers.json must be private and contain an array of unique Provider identities with only providerId and a SHA-256 credentialHash",
    );
  }
}
