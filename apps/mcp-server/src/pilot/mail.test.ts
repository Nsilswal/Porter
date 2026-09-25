import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileMailer, createResendMailer } from "./mail.js";

describe("sign-in email delivery", () => {
  it("stores local links in private unique files without overwriting other requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "porter-mail-"));
    try {
      const mailer = createFileMailer(directory);
      await Promise.all([mailer.send({ to: "first@example.test", url: "http://localhost/signin/verify#first" }), mailer.send({ to: "second@example.test", url: "http://localhost/signin/verify#second" })]);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of files) {
        expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(join(directory, file), "utf8")).subject).toBe("Your Porter sign-in link");
      }
    } finally { await rm(directory, { recursive: true }); }
  });

  it("sends only to the fixed provider with redirects disabled and discards failure bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-provider-detail", { status: 403 }));
    const mailer = createResendMailer("private-email-api-key", "Porter <signin@example.test>", fetcher);
    await expect(mailer.send({ to: "customer@example.test", url: "https://porter.example/signin/verify#private-link" })).rejects.toThrow("Sign-in email delivery is unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.resend.com/emails");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "error", method: "POST" });
    fetcher.mockRejectedValue(new Error("private-email-api-key private-link"));
    let caught: unknown;
    try { await mailer.send({ to: "customer@example.test", url: "https://porter.example/signin/verify#private-link" }); } catch (error) { caught = error; }
    expect(String(caught)).not.toContain("private-link");
    expect(caught).not.toHaveProperty("cause");
  });
});
