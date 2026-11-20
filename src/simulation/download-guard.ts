/**
 * Checks for simulation file downloads (JS-SEC-017).
 *
 * `downloadUrl` values come from the Netra backend. Without checks, any URL it
 * returned was fetched from the app's network, including internal services and
 * cloud metadata endpoints, with no size limit and up to 21 redirects.
 */
import { promises as dns } from "dns";
import { isIP } from "net";

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
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(ip, base, bits));
  if (family === 6) {
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      v6 === "::" ||
      v6 === "::1" ||
      v6.startsWith("fc") ||
      v6.startsWith("fd") || // unique local
      /^fe[89ab]/.test(v6) || // link-local
      v6.startsWith("ff") // multicast
    );
  }
  return false;
}

/** Host of the configured Netra endpoint, which is always allowed. */
function netraHost(): string | undefined {
  const endpoint = process.env.NETRA_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const trusted = host === netraHost();
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
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === netraHost() || isIP(host)) return url;
  const addresses = await dns.lookup(host, { all: true });
  const blocked = addresses.find((a) => isPrivateAddress(a.address));
  if (blocked) {
    throw new Error(`download URL host ${host} resolves to a private address (${blocked.address})`);
  }
  return url;
}
