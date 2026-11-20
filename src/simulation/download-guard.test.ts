/** JS-SEC-017: simulation attachment URLs are checked before download. */
import dns from "dns";
import http from "http";
import { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSafeDownloadUrl, checkDownloadUrlSync, DownloadAgents, isPrivateAddress } from "./download-guard";

describe("download guard", () => {
  const saved = process.env.NETRA_OTLP_ENDPOINT;
  const savedOtel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  afterEach(() => {
    if (saved === undefined) delete process.env.NETRA_OTLP_ENDPOINT;
    else process.env.NETRA_OTLP_ENDPOINT = saved;
    if (savedOtel === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtel;
    vi.restoreAllMocks();
  });

  it.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true],
    ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true], ["::1", true],
    ["fd00::1", true], ["fe80::1", true], ["::ffff:10.0.0.1", true],
    ["8.8.8.8", false], ["52.95.110.1", false], ["2606:4700::1111", false],
    // IPv4 embedded in IPv6, in the hex form new URL() produces
    ["::ffff:7f00:1", true], ["::ffff:a9fe:a9fe", true], ["::ffff:808:808", false],
    ["0:0:0:0:0:ffff:127.0.0.1", true], ["::127.0.0.1", true],
    ["64:ff9b::a9fe:a9fe", true], ["64:ff9b::808:808", false], ["64:ff9b:1::1", true],
    ["2002:a00:1::1", true], ["2002:808:808::1", false],
    ["2001::1", true], ["2001:db8::1", true], ["fec0::1", true], ["ff02::1", true],
    ["fe80::1%eth0", true],
  ])("isPrivateAddress(%s) = %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it("accepts https URLs on public hosts", () => {
    expect(checkDownloadUrlSync("https://bucket.s3.amazonaws.com/file.png?sig=1").hostname).toBe("bucket.s3.amazonaws.com");
  });

  it.each([
    "http://bucket.s3.amazonaws.com/file.png",
    "file:///etc/passwd",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/file",
    "https://10.0.0.5/internal",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:169.254.169.254]/latest/meta-data/",
    "https://[64:ff9b::a9fe:a9fe]/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => checkDownloadUrlSync(url)).toThrow();
  });

  it("allows the configured Netra host, even over http (local or self-hosted)", () => {
    process.env.NETRA_OTLP_ENDPOINT = "http://localhost:3002/telemetry";
    expect(() => checkDownloadUrlSync("http://localhost:3002/files/a.png")).not.toThrow();
    expect(() => checkDownloadUrlSync("http://localhost:9999/files/a.png")).not.toThrow();
  });

  it("refuses a hostname that resolves to a private address", async () => {
    delete process.env.NETRA_OTLP_ENDPOINT;
    await expect(assertSafeDownloadUrl("https://localtest.me/x")).rejects.toThrow();
  });

  it("does not trust a non-Netra OTEL_EXPORTER_OTLP_ENDPOINT host", () => {
    delete process.env.NETRA_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://10.0.0.9:4318";
    expect(() => checkDownloadUrlSync("http://10.0.0.9:4318/files/a.png")).toThrow();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://api.getnetra.ai/telemetry";
    expect(() => checkDownloadUrlSync("https://api.getnetra.ai/files/a.png")).not.toThrow();
  });

  describe("DownloadAgents", () => {
    /** Resolve the given hostnames to 127.0.0.1; leave every other lookup alone. */
    function resolveToLoopback(...hosts: string[]) {
      const original = dns.lookup;
      vi.spyOn(dns, "lookup").mockImplementation(((hostname: string, options: any, callback: any) => {
        if (!hosts.includes(hostname)) return (original as any)(hostname, options, callback);
        const address = { address: "127.0.0.1", family: 4 };
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as any);
    }

    async function withServer(fn: (port: number) => Promise<void>) {
      const server = http.createServer((_req, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await fn((server.address() as AddressInfo).port);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }

    function get(url: string, agent: http.Agent): Promise<string> {
      return new Promise((resolve, reject) => {
        http.get(url, { agent }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        }).on("error", reject);
      });
    }

    it("refuses to connect when a download host resolves to a private address (rebinding, redirects)", async () => {
      resolveToLoopback("files.example.test", "redirect.example.test");
      await withServer(async (port) => {
        const agents = new DownloadAgents(new URL("https://files.example.test/a.png"));
        try {
          await expect(get(`http://files.example.test:${port}/`, agents.httpAgent)).rejects.toThrow(/private address/);
          // A redirect target becomes a download host once beforeRedirect adds it.
          agents.addTarget(new URL("https://redirect.example.test/b.png"));
          await expect(get(`http://redirect.example.test:${port}/`, agents.httpAgent)).rejects.toThrow(/private address/);
        } finally {
          agents.destroy();
        }
      });
    });

    it("resolves other hosts (such as a proxy) normally", async () => {
      resolveToLoopback("proxy.example.test");
      await withServer(async (port) => {
        const agents = new DownloadAgents(new URL("https://files.example.test/a.png"));
        try {
          await expect(get(`http://proxy.example.test:${port}/`, agents.httpAgent)).resolves.toBe("ok");
        } finally {
          agents.destroy();
        }
      });
    });
  });
});
