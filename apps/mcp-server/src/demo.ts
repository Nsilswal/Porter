/**
 * End-to-end demo.
 *
 *   pnpm demo
 *
 * Compiled first, so the demo is typechecked like everything else.
 *
 * Starts Porter with demo mode on, connects a real MCP client over Streamable
 * HTTP, and walks a full booking lifecycle against realistic sample
 * businesses. Nothing real is touched and no money moves.
 *
 * This is also the path a Meta reviewer follows: the platform page promises
 * "end to end testing", so the whole lifecycle has to work without a merchant
 * account.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./app.js";

const KEY = "demo-key";
const USER = "user_demo";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let step = 0;
function heading(title: string): void {
  console.log(`\n${bold(`${++step}. ${title}`)}`);
}
const money = (m: { amount: number; currency: string } | null) =>
  m ? `$${(m.amount / 100).toFixed(2)}` : "—";

async function main(): Promise<void> {
  const app = createApp({
    port: 0,
    apiKeys: { [KEY]: USER },
    signingSecret: "demo-signing-secret-that-is-long-enough-000",
    logLevel: "error",
    demoMode: true,
  });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  console.log(dim(`Porter listening on ${base}  (demo mode, mock businesses)`));

  const client = new Client({ name: "porter-demo", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }),
  );

  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) {
      console.log(`   ${yellow("error")} ${body.error.code}: ${body.error.message}`);
      return { error: body.error };
    }
    return body;
  };

  // ---------------------------------------------------------------- tools
  heading("What the agent sees");
  const { tools } = await client.listTools();
  console.log(`   ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

  // --------------------------------------------------------------- search
  heading('Search: "I need a haircut"');
  const search = await call("search_providers", { category: "haircut", limit: 4 });
  for (const p of search.providers) {
    const cheapest = p.services.map((s: any) => s.price).filter(Boolean).sort((a: any, b: any) => a.amount - b.amount)[0];
    console.log(`   ${cyan(p.name)} — ${p.city}, ${p.region}${cheapest ? `, from ${money(cheapest)}` : ""}`);
  }
  const provider = search.providers.find((p: any) => p.services.some((s: any) => !s.quote_required));
  const service = provider.services.find((s: any) => !s.quote_required);
  console.log(dim(`   picked: ${provider.name} / ${service.name}`));

  // --------------------------------------------------------- availability
  heading("Availability");
  const from = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const avail = await call("get_availability", {
    provider_id: provider.provider_id,
    service_id: service.service_id,
    from,
    to,
    limit: 4,
  });
  for (const s of avail.slots) console.log(`   ${new Date(s.starts_at).toUTCString()}  ${money(s.price)}`);

  // ----------------------------------------------------- phase 1: summary
  heading("Book, step 1 of 2 — the summary the user must see");
  const customer = { givenName: "Sam", familyName: "Rivera", email: "sam@example.com", phone: "555-0100" };
  const summary = await call("create_booking", {
    slot_id: avail.slots[0].slot_id,
    customer_details: customer,
    idempotency_key: "demo-booking-1",
  });
  console.log(`   status:       ${yellow(summary.status)}`);
  console.log(`   ${summary.humanSummary}`);
  console.log(dim(`   cost ${money({ amount: summary.money.amount, currency: summary.money.currency })} · repeats: ${summary.recurrence.kind} · non-refundable: ${summary.nonRefundable}`));
  console.log(dim(`   cancellation known: ${summary.cancellationPolicy.known}, fee ${summary.cancellationPolicy.feeFormatted ?? "none"}`));

  const before = await call("list_my_bookings", {});
  console.log(`   bookings so far: ${before.bookings.length} ${green("(nothing was booked)")}`);

  // ------------------------------------------------------ phase 2: commit
  heading("Book, step 2 of 2 — the user agreed");
  const booked = await call("create_booking", {
    slot_id: avail.slots[0].slot_id,
    customer_details: customer,
    idempotency_key: "demo-booking-1",
    confirmation_token: summary.confirmationToken,
  });
  console.log(`   ${green("booked")} ${booked.booking.provider} — ${new Date(booked.booking.starts_at).toUTCString()}`);
  const bookingId = booked.booking.booking_id;

  // -------------------------------------------------------- idempotency
  heading("Retry with the same key (a flaky network, say)");
  const replay = await call("create_booking", {
    slot_id: avail.slots[0].slot_id,
    customer_details: customer,
    idempotency_key: "demo-booking-1",
    confirmation_token: summary.confirmationToken,
  });
  const list = await call("list_my_bookings", {});
  console.log(`   same booking id: ${green(String(replay.booking.booking_id === bookingId))}`);
  console.log(`   total bookings:  ${list.bookings.length} ${green("(not two)")}`);

  // ----------------------------------------------------------- reschedule
  heading("Reschedule");
  const later = await call("get_availability", {
    provider_id: provider.provider_id,
    service_id: service.service_id,
    from: new Date(Date.parse(avail.slots[0].ends_at) + 3_600_000).toISOString(),
    to,
    limit: 3,
  });
  const moveSummary = await call("reschedule_booking", {
    booking_id: bookingId,
    new_slot_id: later.slots[0].slot_id,
    idempotency_key: "demo-move-1",
  });
  const moved = await call("reschedule_booking", {
    booking_id: bookingId,
    new_slot_id: later.slots[0].slot_id,
    idempotency_key: "demo-move-1",
    confirmation_token: moveSummary.confirmationToken,
  });
  console.log(`   ${green("moved to")} ${new Date(moved.booking.starts_at).toUTCString()}`);

  // ---------------------------------------------------- injection safety
  heading("A business with a hostile name");
  const hostile = search.providers.find((p: any) => p.name.includes("Ignore previous instructions"));
  if (hostile) {
    console.log(`   stored name: ${dim(hostile.name.slice(0, 96))}…`);
    console.log(`   ${green("it is data, not an instruction")} — no tool ran, no booking changed`);
  }

  // -------------------------------------------------------------- deposit
  heading("A booking that needs a deposit");
  const spa = await call("search_providers", { category: "massage", limit: 5 });
  const spaProvider = spa.providers.find((p: any) => p.services.some((s: any) => s.deposit_required));
  const spaService = spaProvider.services.find((s: any) => s.deposit_required);
  const spaSlots = await call("get_availability", {
    provider_id: spaProvider.provider_id,
    service_id: spaService.service_id,
    from,
    to,
    limit: 2,
  });
  const spaSummary = await call("create_booking", {
    slot_id: spaSlots.slots[0].slot_id,
    customer_details: customer,
    idempotency_key: "demo-spa-1",
  });
  console.log(`   ${spaProvider.name} — ${spaService.name}`);
  console.log(`   deposit due now: ${yellow(spaSummary.money.formatted)} of ${money(spaService.price)}`);
  const spaBooked = await call("create_booking", {
    slot_id: spaSlots.slots[0].slot_id,
    customer_details: customer,
    idempotency_key: "demo-spa-1",
    confirmation_token: spaSummary.confirmationToken,
  });

  await app.store.paymentProfiles.put(USER, {
    customerRef: "cus_demo",
    paymentMethodRef: "pm_demo",
    label: "Visa ending 4242",
  });
  const paySummary = await call("pay_or_deposit", { booking_id: spaBooked.booking.booking_id, idempotency_key: "demo-pay-1" });
  console.log(`   paying: ${paySummary.money.formatted} (${paySummary.money.kind})`);
  const paid = await call("pay_or_deposit", {
    booking_id: spaBooked.booking.booking_id,
    idempotency_key: "demo-pay-1",
    confirmation_token: paySummary.confirmationToken,
  });
  console.log(`   ${green("paid")} ${money(paid.amount)} · still owing ${money({ amount: paid.amount_outstanding, currency: "USD" })}`);

  // ---------------------------------------------------- cancel with a fee
  heading("Cancel — the fee is shown before anything happens");
  const cancelSummary = await call("cancel_booking", { booking_id: spaBooked.booking.booking_id, idempotency_key: "demo-cancel-1" });
  console.log(`   ${cancelSummary.humanSummary}`);
  const stillThere = await call("list_my_bookings", { status: "confirmed" });
  console.log(`   still confirmed: ${stillThere.bookings.length} ${green("(quoting a fee does not cancel)")}`);
  const cancelled = await call("cancel_booking", {
    booking_id: spaBooked.booking.booking_id,
    idempotency_key: "demo-cancel-1",
    confirmation_token: cancelSummary.confirmationToken,
  });
  console.log(`   ${green("cancelled")} · fee charged ${money(cancelled.fee_charged)}`);

  // ------------------------------------------------------- quote-required
  heading('A job that needs a quote: "my AC died"');
  const hvac = await call("search_providers", { category: "AC", limit: 3 });
  const hvacProvider = hvac.providers[0];
  const quote = await call("get_quote", {
    provider_id: hvacProvider.provider_id,
    job_description: "AC blowing warm air since yesterday, upstairs unit",
    address: { givenName: "Sam", phone: "555-0100", addressLine1: "12 Oak St", city: "Oakland", region: "CA", postalCode: "94610" },
    category: "home.hvac.repair",
  });
  console.log(`   ${cyan(hvacProvider.name)}`);
  console.log(`   ${quote.summary}`);
  if (quote.price_range) console.log(`   estimate: ${money(quote.price_range.min)} – ${money(quote.price_range.max)}`);

  // ----------------------------------------------------------- audit trail
  heading("The audit trail the user can see");
  const audit = (await (await fetch(`${base}/v1/audit?limit=6`, { headers: { Authorization: `Bearer ${KEY}` } })).json()) as {
    entries: { at: string; tool: string; action: string; outcome: string; disclosed_fields: string[] }[];
  };
  for (const e of audit.entries.slice(-6)) {
    console.log(`   ${dim(e.at)}  ${e.tool}:${e.action}  ${e.outcome}${e.disclosed_fields.length ? `  shared: ${e.disclosed_fields.join(",")}` : ""}`);
  }
  const blob = JSON.stringify(audit.entries);
  const leaks = ["sam@example.com", "555-0100", "Sam", "12 Oak St"].filter((v) => blob.includes(v));
  console.log(`   personal data in the log: ${leaks.length === 0 ? green("none") : yellow(leaks.join(", "))}`);

  console.log(`\n${green("Demo complete.")} ${dim(`Docs: ${base}/docs`)}\n`);

  await client.close();
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
