import { defineInterface } from "@agentorg/sdk";

/**
 * `http.egress@1`: HTTPS requests to the public internet, made for the caller by the provider.
 * A request names its destination by its absolute `https:` URL. A slot of it is a host module's
 * whole network.
 */
export const httpEgress = defineInterface({ name: "http.egress", major: 1, kind: "http" });
