/**
 * Checks for simulation file downloads (JS-SEC-017).
 *
 * `downloadUrl` values come from the Netra backend. Without checks, any URL it
 * returned was fetched from the app's network, including internal services and
 * cloud metadata endpoints, with no size limit and up to 21 redirects.
 */
import dns, { promises as dnsPromises, LookupAddress } from "dns";
import http from "http";
import https from "https";
import { isIP } from "net";
import { isNetraHost } from "../config";

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_DOWNLOAD_REDIRECTS = 3;

/** Largest file accepted, from NETRA_SIMULATION_MAX_FILE_BYTES (default 50 MiB). */
export function maxDownloadBytes(): number {
  const value = Number(process.env.NETRA_SIMULATION_MAX_FILE_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_FILE_BYTES;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * The 16 bytes of an IPv6 address, or undefined if it is not one. Parsing to
 * bytes, instead of matching text, catches every spelling of an address:
 * `new URL()` rewrites `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, which a
 * dotted-quad pattern never matched.
 */
function parseIPv6(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  // A trailing dotted IPv4 part becomes two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const [head, rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const fill = text.includes("::") ? 8 - headGroups.length - restGroups.length : 0;
  const groups = [...headGroups, ...Array(fill).fill("0"), ...restGroups];
  if (groups.length !== 8) return undefined;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function startsWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function v4FromBytes(bytes: number[], offset: number): string {
  return bytes.slice(offset, offset + 4).join(".");
}

function isPrivateIPv6(bytes: number[]): boolean {
  const allZeroUpTo = (n: number) => bytes.slice(0, n).every((b) => b === 0);

  // Forms that carry an IPv4 address: judge the embedded address.
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateAddress(v4FromBytes(bytes, 12));
  }
  // ::a.b.c.d (deprecated IPv4-compatible), and :: / ::1
  if (allZeroUpTo(12)) {
    return true;
  }
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local-use NAT64)
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b])) {
    const wellKnown = bytes.slice(4, 12).every((b) => b === 0);
    return wellKnown ? isPrivateAddress(v4FromBytes(bytes, 12)) : true;
  }
  // 2002::/16 (6to4): IPv4 address in bytes 2-5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateAddress(v4FromBytes(bytes, 2));
  }
  // 2001::/32 (Teredo): the server and client addresses are obfuscated
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00])) return true;
  // 2001:db8::/32 (documentation)
  if (startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8])) return true;
  // 100::/64 (discard)
  if (startsWith(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0])) return true;

  return (
    (bytes[0] & 0xfe) === 0xfc || // fc00::/7 unique local
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || // fe80::/10 link-local
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) || // fec0::/10 site-local (deprecated)
    bytes[0] === 0xff // ff00::/8 multicast
  );
}

/**
 * True for loopback, private, link-local, CGNAT, multicast, documentation and
 * reserved addresses, including IPv4 addresses embedded in IPv6 (mapped,
 * compatible, NAT64, 6to4) in any spelling.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(ip, base, bits));
  if (family === 6) {
    const bytes = parseIPv6(ip);
    // Unparseable: refuse rather than guess.
    return bytes ? isPrivateIPv6(bytes) : true;
  }
  return false;
}

/**
 * Host of the Netra endpoint, which is always allowed (a local or self-hosted
 * Netra may use http and a private address). NETRA_OTLP_ENDPOINT is explicit
 * Netra configuration and always counts. OTEL_EXPORTER_OTLP_ENDPOINT often
 * points at another vendor or a shared collector, so it counts only when it is
 * a Netra host (as for the API key, JS-SEC-006).
 */
function trustedNetraHost(): string | undefined {
  const netra = process.env.NETRA_OTLP_ENDPOINT;
  const otel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = netra || (otel && isNetraHost(otel) ? otel : undefined);
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Synchronous checks on a URL: scheme and literal host. Used for the first
 * URL and for every redirect target.
 */
export function checkDownloadUrlSync(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("download URL is not a valid URL");
  }
  const host = hostOf(url);
  const trusted = host === trustedNetraHost();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && trusted)) {
    throw new Error(`download URL must use https (got ${url.protocol})`);
  }
  if (!trusted && (host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host))) {
    throw new Error(`download URL points to a private or local address (${host})`);
  }
  return url;
}

/**
 * Full check before downloading: scheme, literal host, and every address the
 * hostname resolves to.
 */
export async function assertSafeDownloadUrl(raw: string): Promise<URL> {
  const url = checkDownloadUrlSync(raw);
  const host = hostOf(url);
  if (host === trustedNetraHost() || isIP(host)) return url;
  const addresses = await dnsPromises.lookup(host, { all: true });
  const blocked = addresses.find((a) => isPrivateAddress(a.address));
  if (blocked) {
    throw new Error(`download URL host ${host} resolves to a private address (${blocked.address})`);
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * HTTP agents for one download whose DNS lookup refuses private addresses for
 * the download's own hosts (the first URL and each redirect target, added with
 * `addTarget`). The check runs on the addresses the socket actually connects
 * to, so a redirect to a hostname that resolves to a private address, or a
 * DNS answer that changes between a check and the connection (rebinding), is
 * refused. Other hosts, such as an HTTP proxy from the environment, resolve
 * normally. IP literals never reach `lookup`; `checkDownloadUrlSync` covers them.
 */
export class DownloadAgents {
  readonly httpAgent: http.Agent;
  readonly httpsAgent: https.Agent;
  private readonly targets = new Set<string>();

  constructor(url: URL) {
    this.addTarget(url);
    const lookup = this.lookup.bind(this) as any;
    this.httpAgent = new http.Agent({ lookup });
    this.httpsAgent = new https.Agent({ lookup });
  }

  addTarget(url: URL): void {
    this.targets.add(hostOf(url));
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private lookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      if (this.targets.has(host) && host !== trustedNetraHost()) {
        const blocked = addresses.find((a) => isPrivateAddress(a.address));
        if (blocked) {
          return callback(
            new Error(`download URL host ${host} resolves to a private address (${blocked.address})`),
            [],
          );
        }
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error(`no address found for ${host}`), []);
      callback(null, first.address, first.family);
    });
  }
}
