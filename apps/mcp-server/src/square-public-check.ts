/**
 * Read any Square public booking page.
 *
 *   pnpm square:public <url>
 *
 * Point it at a book.squareup.com booking page and it prints exactly what
 * Porter extracts: the business, its services with real prices and durations,
 * and the cancellation terms. No account, no key, no config.
 */
import { createFetchHttpClient, sanitize, silentLogger, PorterError } from "@porter/shared";
import { createSquarePublicAdapter } from "@porter/adapter-square-public";
import type { AdapterContext } from "@porter/core";

const DEFAULT_URL =
  "https://book.squareup.com/appointments/3ad58156-d5b2-41cc-977b-3012c7b8cb1a/location/V5TTHCVB1F1ER/services";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const cash = (minor: number) => `$${(minor / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;
  if (!/^https:\/\/book\.squareup\.com\/appointments\//.test(url)) {
    console.error(`
${yellow("That does not look like a Square booking page.")}

  Expected something like:
    https://book.squareup.com/appointments/<site-id>/location/<location-id>/services

  Find one by searching for a salon and clicking "Book now", or run with no
  argument to use the built-in example.
`);
    process.exit(1);
  }

  const adapter = createSquarePublicAdapter({
    http: createFetchHttpClient({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    }),
    sources: [{ key: "target", url, categories: ["beauty.haircut"] }],
  });

  const ctx: AdapterContext = {
    actorId: "check",
    log: silentLogger,
    signal: AbortSignal.timeout(45_000),
    credentials: {},
    now: new Date(),
  };

  console.log(dim(`\nreading ${url}\n`));

  let results;
  try {
    results = await adapter.searchProviders({ categories: [], limit: 1 }, ctx);
  } catch (error) {
    if (PorterError.is(error) && error.code === "HUMAN_ACTION_REQUIRED") {
      console.error(`${yellow("Blocked:")} ${error.message}`);
      console.error(dim(`  ${String(error.details.url)}`));
      process.exit(1);
    }
    throw error;
  }

  const result = results[0];
  if (!result) {
    console.error(yellow("No bookable services found on that page."));
    process.exit(1);
  }

  const location = result.provider.locations[0]!;
  console.log(bold(sanitize(result.provider.name)));
  console.log(
    dim(
      `${sanitize(location.address.line1)}, ${sanitize(location.address.city)}, ` +
        `${sanitize(location.address.region)} ${sanitize(location.address.postalCode)} · ${location.timezone}`,
    ),
  );

  const fixed = result.services.filter((s) => s.price);
  const ranged = result.services.filter((s) => !s.price && s.priceRange);
  const quoted = result.services.filter((s) => !s.price && !s.priceRange);

  console.log(
    `\n${bold(`${result.services.length} services`)}  ` +
      dim(`${fixed.length} fixed price · ${ranged.length} with a stated range · ${quoted.length} quote-only`),
  );

  for (const service of result.services.slice(0, 20)) {
    const price = service.price
      ? green(cash(service.price.amount).padStart(9))
      : service.priceRange
        ? cyan(`${cash(service.priceRange.min.amount)}–${cash(service.priceRange.max.amount)}`.padStart(9))
        : yellow("on quote".padStart(9));
    console.log(`  ${sanitize(service.name).slice(0, 52).padEnd(54)} ${String(service.durationMinutes).padStart(3)}min  ${price}`);
  }
  if (result.services.length > 20) console.log(dim(`  … and ${result.services.length - 20} more`));

  // The cancellation terms, for the service most likely to carry a real fee.
  const target = ranged[0] ?? fixed[0] ?? result.services[0]!;
  const startsAt = new Date(Date.now() + 7 * 86_400_000);
  const policy = await adapter.getServiceCancellationPolicy!(
    { providerId: result.provider.id, serviceId: target.id, startsAt },
    ctx,
  );

  console.log(`\n${bold("Cancellation terms")} ${dim(`for "${sanitize(target.name).slice(0, 44)}"`)}`);
  if (!policy.known) {
    console.log(`  ${yellow("not published by this business")} ${dim("— Porter reports unknown rather than implying it is free")}`);
  } else {
    if (policy.freeUntil) {
      const hours = Math.round((startsAt.getTime() - policy.freeUntil.getTime()) / 3_600_000);
      console.log(`  free to cancel until ${green(`${hours}h before`)} the appointment`);
    }
    console.log(`  fee after that: ${policy.feeAmount ? green(cash(policy.feeAmount.amount)) : dim("none")}`);
    if (policy.text) console.log(dim(`  "${sanitize(policy.text, { maxLength: 150 })}"`));
  }

  console.log(
    `\n${dim("Porter books this page when the business does not collect a card.")}\n` +
      `${dim("A deposit, a no-show hold, or a card on file is finished on the page itself.")}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
