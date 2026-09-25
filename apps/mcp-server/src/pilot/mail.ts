import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SignInEmail {
  readonly to: string;
  readonly url: string;
}

export interface SignInMailer {
  send(message: SignInEmail): Promise<void>;
}

/** Local testing only. These private files contain live, single-use links. */
export function createFileMailer(directory: string): SignInMailer {
  return {
    async send(message) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const file = await open(join(directory, `${randomUUID()}.json`), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ to: message.to, subject: "Your Porter sign-in link", url: message.url }, null, 2) + "\n");
      } finally {
        await file.close();
      }
    },
  };
}

/** Configurable production sender. Provider failures never expose response bodies. */
export function createResendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): SignInMailer {
  if (!apiKey.trim() || !from.trim() || /[\r\n]/.test(from)) throw new Error("Invalid sign-in email configuration");
  return {
    async send({ to, url }) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from, to: [to], subject: "Your Porter sign-in link",
            text: `Continue signing in to Porter in the browser where you requested this link:\n\n${url}\n\nThis link expires in 15 minutes and works once. If you did not request it, you can ignore this email.`,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
      } catch {
        throw new Error("Sign-in email delivery is unavailable");
      }
      if (!response.ok) throw new Error("Sign-in email delivery is unavailable");
    },
  };
}
