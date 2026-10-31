/** Preconfigured Provider identities and admission, independent of organizational Actor identities. */

export interface ProviderIdentity {
  providerId: string;
  credentialHash: string;
}

export function providers(configured: readonly ProviderIdentity[]) {
  const identities = new Map<string, string>();
  for (const identity of configured) {
    if (!identity.providerId || !/^[a-f\d]{64}$/i.test(identity.credentialHash)) {
      throw new Error("a Provider needs an identity and SHA-256 credential hash");
    }
    if (identities.has(identity.providerId)) throw new Error("Provider identities must be unique");
    identities.set(identity.providerId, identity.credentialHash.toLowerCase());
  }
  return {
    ids: () => [...identities.keys()],
    has: (providerId: string): boolean => identities.has(providerId),
    async admit(providerId: string, credential?: string): Promise<boolean> {
      const expected = identities.get(providerId);
      if (expected === undefined || credential === undefined) return false;
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
      const hash = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return hash === expected;
    },
  };
}

export type Providers = ReturnType<typeof providers>;
