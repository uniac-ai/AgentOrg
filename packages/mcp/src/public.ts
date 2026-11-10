// An address on the public internet, and a fetch that reaches nothing else: not this machine, not
// its network, and no redirect, which could lead anywhere.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const NOT_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  NOT_PUBLIC.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NOT_PUBLIC.addSubnet(address, prefix, "ipv6");

/** Whether an IP address is one anyone on the internet could reach. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4 address written as IPv6 is the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  return !NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Why an address isn't a public https one, or nothing when it is. */
export async function notPublic(url: string): Promise<string | undefined> {
  if (!URL.canParse(url)) return "That isn't an address.";
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:") return "Only an https address can be used.";
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((one) => one.address);
  } catch {
    return `${hostname} can't be found.`;
  }
  return addresses.length && addresses.every(isPublicAddress)
    ? undefined
    : `${hostname} isn't on the public internet.`;
}

/** A fetch for a public server: it checks where each request goes, and never follows a redirect. */
export const publicFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const why = await notPublic(url);
  if (why) throw new Error(why);
  return fetch(input, { ...init, redirect: "error" });
};
