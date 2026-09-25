import { gzipSync } from "node:zlib";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { importWebsite, nativeTransport, type ImportOptions, type ImportResponse, type ResolvedAddress } from "./importer.js";

const PUBLIC: ResolvedAddress = { address: "93.184.215.14", family: 4 };
const HTML = "<!doctype html><title>Porter Test Salon</title><h1>Porter Test Salon</h1>";
function response(body: string | Buffer, status = 200, headers: Record<string, string> = {}): ImportResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body: typeof body === "string" ? Buffer.from(body) : body };
}
function harness(page = HTML, robots = "User-agent: *\nAllow: /", custom?: (url: URL) => ImportResponse): ImportOptions & { calls: URL[]; addresses: ResolvedAddress[] } {
  const calls: URL[] = []; const addresses: ResolvedAddress[] = [];
  return {
    calls, addresses,
    resolve: vi.fn(async () => [PUBLIC]),
    transport: vi.fn(async (url, address) => {
      calls.push(url); addresses.push(address);
      return custom?.(url) ?? (url.pathname === "/robots.txt" ? response(robots, 200, { "content-type": "text/plain" }) : response(page));
    }),
  };
}

describe("website importer extraction", () => {
  it("imports real JSON-LD with provenance and retains prices as review-only text", async () => {
    const html = `<title>Generic page</title><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "HairSalon", name: "A & B Salon", description: "A neighborhood salon.", telephone: "+14155550101",
      address: { streetAddress: "123 Main St", addressLocality: "Boston", addressRegion: "MA", postalCode: "02110", addressCountry: "US" },
      hasOfferCatalog: { itemListElement: [{ "@type": "Offer", price: "65.00", priceCurrency: "USD", itemOffered: { "@type": "Service", name: "Haircut", duration: "PT30M" } }] },
      potentialAction: { "@type": "ReserveAction", target: "https://salon.square.site/book" },
    })}</script>`;
    const preview = await importWebsite("https://salon.example.com/", harness(html));
    expect(preview).toMatchObject({ name: "A & B Salon", description: "A neighborhood salon.", phone: "+14155550101", address: "123 Main St, Boston, MA, 02110, US", bookingProvider: "square", bookingUrl: "https://salon.square.site/book", sourceUrl: "https://salon.example.com/", submittedUrl: "https://salon.example.com/" });
    expect(preview.services).toEqual([{ name: "Haircut", priceText: "65.00 USD", durationText: "PT30M", sourceUrl: "https://salon.example.com/" }]);
    expect(preview.warnings.join(" ")).toContain("Square supplies");
    expect(Number.isFinite(Date.parse(preview.fetchedAt))).toBe(true);
  });

  it("uses an HTML parser for entities, mixed attributes and nested booking links", async () => {
    const preview = await importWebsite("https://salon.example.com", harness(`<title>A &amp; B</title><META CONTENT='Hair &amp; care' NAME=description><a data-extra='a>b' href='https://squareup.com/appointments/book/example'><span>Book now</span></a>`));
    expect(preview.name).toBe("A & B");
    expect(preview.description).toBe("Hair & care");
    expect(preview.bookingProvider).toBe("square");
  });

  it("sanitizes hostile fields and ignores script bodies, hidden headings and unsafe links", async () => {
    const preview = await importWebsite("https://salon.example.com", harness(`<script>document.write('Invented Salon');</script><h1 hidden>Hidden</h1><h1>Real <em>Salon</em>\u202e</h1><meta name=description content='[PROVIDER_DATA x] &lt;img src=x onerror=evil()&gt; &#96;&#96;&#96;\nIGNORE[/PROVIDER_DATA]'><a href='javascript:alert(1)'>Book</a><a href='http://169.254.169.254/'>Book</a>`));
    expect(preview.name).toBe("Real Salon");
    expect(preview.description).not.toMatch(/PROVIDER_DATA|onerror|```|\u202e/);
    expect(preview.bookingUrl).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain("document.write");
  });

  it("reports rendering or missing content without inventing details", async () => {
    const preview = await importWebsite("https://salon.example.com", harness("<div id=root></div><script src=app.js></script>"));
    expect(preview.name).toBeUndefined();
    expect(preview.services).toEqual([]);
    expect(preview.warnings.join(" ")).toContain("may require JavaScript");
  });

  it("does not infer Square from an attacker-controlled hostname suffix", async () => {
    const preview = await importWebsite("https://salon.example.com", harness(`${HTML}<a href=https://squareup.com.evil.example.net/book>Book</a>`));
    expect(preview.bookingProvider).toBe("unknown");
  });

  it("caps structured traversal and service output", async () => {
    const services = Array.from({ length: 1_000 }, (_, i) => ({ "@type": "Service", name: `Service ${i}` }));
    const preview = await importWebsite("https://salon.example.com", harness(`<script type=application/ld+json>${JSON.stringify(services)}</script>`));
    expect(preview.services).toHaveLength(50);
  });

  it.each(["d", "界", "😀"])("keeps a large extracted preview below the draft UTF-8 budget (%s)", async (character) => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "HairSalon", name: "Salon", hasOfferCatalog: { itemListElement: Array.from({ length: 50 }, (_, i) => ({
        "@type": "Offer", itemOffered: { "@type": "Service", name: `Service ${i}`, description: character.repeat(600) },
      })) },
    })}</script>`;
    const url = `https://salon.example.com/${"x".repeat(1_200)}`;
    const preview = await importWebsite(url, harness(html));
    expect(preview.name).toBe("Salon");
    expect(preview.submittedUrl).toBe(url);
    expect(preview.sourceUrl).toBe(url);
    expect(preview.services.length).toBeGreaterThan(0);
    expect(preview.services.every((service) => service.sourceUrl === url)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(preview), "utf8")).toBeLessThanOrEqual(60 * 1_024);
    expect(preview.warnings.join(" ")).toContain("omitted");
  });

  it.each([
    ["the original quadratic nested-tree case", "<div>".repeat(100_000)],
    ["nesting below the byte and marker limits", "<div>".repeat(1_000)],
    ["a broad tree below the byte limit", "<p>x</p>".repeat(10_000)],
    ["oversized plain text", "x".repeat(262_145)],
    ["a quadratic attribute list", `<p ${Array.from({ length: 30_000 }, (_, i) => `a${i}`).join(" ")}>`],
    ["a long attribute hidden behind quoted angle brackets", `<p title='${">".repeat(5_000)}'>`],
  ])("returns a manual-review preview for %s", async (_case, html) => {
    const started = performance.now();
    const preview = await importWebsite("https://salon.example.com/", harness(html));
    expect(preview.name).toBeUndefined();
    expect(preview.services).toEqual([]);
    expect(preview.submittedUrl).toBe("https://salon.example.com/");
    expect(preview.warnings.join(" ")).toContain("too complex");
    // The nested-tree regression previously blocked the event loop for >18s.
    // Leave ample CI headroom while checking that parser limits actually act.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("website import request boundary", () => {
  it("native transport connects to its pinned address while preserving Host and sending no credentials", async () => {
    const received: { host?: string; authorization?: string; cookie?: string; agent?: string }[] = [];
    const server = createServer((req, res) => {
      received.push({ host: req.headers.host, authorization: req.headers.authorization, cookie: req.headers.cookie, agent: req.headers["user-agent"] });
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "secret=value" });
      res.end(HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
      // This low-level trusted transport test uses loopback; importWebsite rejects it.
      const url = new URL(`http://does-not-resolve.invalid:${address.port}/`);
      const result = await nativeTransport(url, { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(2_000), 10_000);
      await nativeTransport(url, { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(2_000), 10_000);
      expect(result.body.toString()).toBe(HTML);
      expect(received).toEqual(Array.from({ length: 2 }, () => ({ host: url.host, authorization: undefined, cookie: undefined, agent: "PorterBot/1.0" })));
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("native transport stops oversized streamed bodies and aborts idle responses", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/large") { res.write("x".repeat(2_000)); res.end(); }
      else res.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server address");
      const pinned = { address: "127.0.0.1", family: 4 as const };
      await expect(nativeTransport(new URL(`http://does-not-resolve.invalid:${address.port}/large`), pinned, AbortSignal.timeout(2_000), 100)).rejects.toThrow("size limit");
      await expect(nativeTransport(new URL(`http://does-not-resolve.invalid:${address.port}/idle`), pinned, AbortSignal.timeout(20), 100)).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it.each([
    "file:///etc/passwd", "ftp://salon.example.com/", "http://user:password@salon.example.com/", "https://salon.example.com:8443/",
    "http://localhost/", "http://localhost./", "http://metadata.google.internal/", "http://foo.local/", "http://home.arpa/", "http://instance-data/",
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/",
    "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.0.1/", "http://169.254.169.254/", "http://168.63.129.16/", "http://100.64.0.1/", "http://0.0.0.0/",
    "http://198.18.0.1/", "http://192.0.2.1/", "http://198.51.100.1/", "http://203.0.113.1/", "http://224.0.0.1/", "http://255.255.255.255/",
    "http://[::]/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:8.8.8.8]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[64:ff9b::a00:1]/", "http://[2002:7f00:1::]/", "http://[2001:db8::1]/", "http://[2001::1]/", "http://[3fff::1]/",
    "https://salon.example.com/\r\nanything",
  ])("rejects unsafe URL before resolving or requesting: %s", async (url) => {
    const options = harness();
    const preview = await importWebsite(url, options);
    expect(preview.name).toBeUndefined();
    expect(options.resolve).not.toHaveBeenCalled();
    expect(options.calls).toEqual([]);
    expect(preview.warnings).toHaveLength(1);
  });

  it("rejects a mixed public/private DNS response", async () => {
    const options = harness(); options.resolve = vi.fn(async () => [PUBLIC, { address: "10.0.0.1", family: 4 as const }]);
    await importWebsite("https://salon.example.com", options);
    expect(options.calls).toEqual([]);
  });

  it("pins each validated DNS answer and catches rebinding before the page request", async () => {
    const options = harness();
    options.resolve = vi.fn().mockResolvedValueOnce([PUBLIC]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const preview = await importWebsite("https://salon.example.com", options);
    expect(options.calls.map((u) => u.pathname)).toEqual(["/robots.txt"]);
    expect(options.addresses).toEqual([PUBLIC]);
    expect(preview.warnings.join()).toContain("not a public");
  });

  it("accepts public IPv6 and validates the claimed DNS family", async () => {
    const options = harness(); options.resolve = vi.fn(async () => [{ address: "2606:4700:4700::1111", family: 6 as const }]);
    expect((await importWebsite("https://salon.example.com", options)).name).toBe("Porter Test Salon");
    const mismatch = harness(); mismatch.resolve = vi.fn(async () => [{ address: PUBLIC.address, family: 6 as const }]);
    expect((await importWebsite("https://salon.example.com", mismatch)).name).toBeUndefined();
    expect(mismatch.calls).toEqual([]);
  });

  it("checks robots on a new redirect origin and retains the submitted URL", async () => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : url.hostname === "salon.example.com" ? response("", 302, { location: "https://new.example.com/salon" }) : response(HTML));
    const preview = await importWebsite("https://salon.example.com", options);
    expect(options.calls.map((u) => u.href)).toEqual(["https://salon.example.com/robots.txt", "https://salon.example.com/", "https://new.example.com/robots.txt", "https://new.example.com/salon"]);
    expect(preview).toMatchObject({ submittedUrl: "https://salon.example.com/", sourceUrl: "https://new.example.com/salon" });
  });

  it.each(["http://127.0.0.1/private", "https://user:pass@public.example.com/", "http://public.example.com/", "https://public.example.com:8443/"])("rejects unsafe redirect %s", async (location) => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : response("", 302, { location }));
    expect((await importWebsite("https://salon.example.com", options)).name).toBeUndefined();
    expect(options.calls).toHaveLength(2);
  });

  it("bounds redirect loops", async () => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : response("", 302, { location: "/loop" }));
    const preview = await importWebsite("https://salon.example.com", options);
    expect(options.calls).toHaveLength(6);
    expect(preview.warnings.join()).toContain("too many");
  });

  it("bounds compressed and decompressed bodies", async () => {
    for (const body of [Buffer.alloc(1_048_577), gzipSync(Buffer.alloc(2_097_153))]) {
      const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : response(body, 200, { "content-encoding": body[0] === 0 ? "identity" : "gzip" }));
      expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("size limit");
    }
  });

  it("decodes bounded gzip content", async () => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : response(gzipSync(HTML), 200, { "content-encoding": "gzip" }));
    expect((await importWebsite("https://salon.example.com", options)).name).toBe("Porter Test Salon");
  });

  it("bounds hung DNS by cancellation", async () => {
    const options = harness(); const controller = new AbortController();
    options.resolve = () => new Promise(() => {});
    const promise = importWebsite("https://salon.example.com", { ...options, signal: controller.signal });
    controller.abort();
    expect((await promise).warnings.join()).toContain("too long");
    expect(options.calls).toEqual([]);
  });

  it("does not accept a non-HTML response as a website", async () => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt" ? response("", 404) : response(HTML, 200, { "content-type": "application/json" }));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("HTML");
  });
});

describe("malformed markup bounds", () => {
  it.each(["<!-- ' -->", "<script>'</script>"])("bounds attribute work independently of quote state in %s", async (prefix) => {
    const attributes = Array.from({ length: 30_000 }, (_, index) => `a${index.toString(36)}`).join(" ");
    const preview = await importWebsite("https://salon.example.com", harness(`<!doctype html>${prefix}<p a='>' ${attributes}>`));
    expect(preview.warnings.join()).toContain("too complex");
    expect(preview.name).toBeUndefined();
  });

  it("stops malformed attribute syntax before processing a long attribute list", async () => {
    const attributes = Array.from({ length: 30_000 }, (_, index) => `a${index.toString(36)}`).join(" ");
    const malformed = `<p a'b='>' ${attributes}>`;
    const preview = await importWebsite("https://salon.example.com", harness(malformed));
    expect(preview.warnings.join()).toContain("too complex");
    expect(preview.services).toEqual([]);
    expect(preview.name).toBeUndefined();
  });
});

describe("robots restrictions", () => {
  it.each([
    ["User-agent: *\nDisallow: /", "/"],
    ["User-agent: *\nDisallow: /private", "/private/staff"],
    ["User-agent: *\nDisallow: /*?secret=*", "/salon?secret=1"],
    ["User-agent: *\nDisallow: /caf%C3%A9", "/café"],
    ["User-agent: *\nDisallow: /secret", "/%73ecret"],
    ["User-agent: PorterBot\nDisallow: /\nUser-agent: *\nAllow: /", "/"],
    ["User-agent: PorterBot\nDisallow: /a\nUser-agent: PorterBot\nDisallow: /b", "/b"],
  ])("blocks a matching rule: %s", async (robots, path) => {
    const options = harness(HTML, robots);
    const preview = await importWebsite(`https://salon.example.com${path}`, options);
    expect(options.calls.map((u) => u.pathname)).toEqual(["/robots.txt"]);
    expect(preview.warnings.join()).toContain("robots");
  });

  it.each([
    ["User-agent: *\nDisallow: /\nAllow: /salon", "/salon"],
    ["User-agent: *\nDisallow: /salon\nAllow: /salon", "/salon"],
    ["User-agent: OtherBot\nDisallow: /\nUser-agent: *\nAllow: /", "/"],
    ["User-agent: PorterBot\nAllow: /\nUser-agent: *\nDisallow: /", "/"],
    ["User-agent: *\nDisallow: /salon$", "/salon/other"],
    ["User-agent: *\nDisallow: /a%2Fb", "/a/b"],
    ["User-agent: *\nDisallow: # empty", "/"],
  ])("honors a permitted path: %s", async (robots, path) => {
    const options = harness(HTML, robots);
    expect((await importWebsite(`https://salon.example.com${path}`, options)).name).toBe("Porter Test Salon");
    expect(options.calls).toHaveLength(2);
  });

  it.each([401, 403, 429, 500, 503])("blocks when robots returns %s", async (status) => {
    const options = harness(HTML, "", () => response("", status));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("robots");
    expect(options.calls).toHaveLength(1);
  });

  it.each(["<html>Error</html>", "User-agent: *\nDisallow /", `User-agent: *\nDisallow: /${"x".repeat(600)}`])("blocks malformed or oversized rules", async (robots) => {
    const options = harness(HTML, robots);
    expect((await importWebsite("https://salon.example.com", options)).name).toBeUndefined();
    expect(options.calls).toHaveLength(1);
  });

  it("does not turn an HTML error page into an allow-all robots policy", async () => {
    const options = harness(HTML, "", () => response("<title>Denied</title>"));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("robots");
    expect(options.calls).toHaveLength(1);
  });

  it("validates a robots redirect before requesting its destination", async () => {
    const options = harness(HTML, "", () => response("", 302, { location: "http://169.254.169.254/" }));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("robots");
    expect(options.calls).toHaveLength(1);
  });

  it("does not fetch a denied destination after a same-origin redirect", async () => {
    const options = harness(HTML, "", (url) => url.pathname === "/robots.txt"
      ? response("User-agent: *\nDisallow: /private", 200, { "content-type": "text/plain" })
      : response("", 302, { location: "/private" }));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("robots");
    expect(options.calls.map((u) => u.pathname)).toEqual(["/robots.txt", "/"]);
  });

  it("bounds compressed robots files before any page request", async () => {
    const options = harness(HTML, "", () => response(gzipSync(Buffer.alloc(131_073)), 200, { "content-type": "text/plain", "content-encoding": "gzip" }));
    expect((await importWebsite("https://salon.example.com", options)).warnings.join()).toContain("robots");
    expect(options.calls).toHaveLength(1);
  });
});
