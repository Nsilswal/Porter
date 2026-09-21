import { z } from "zod";
import { PorterError } from "@porter/shared";
import type { Actor, BookingEngine } from "@porter/core";

/**
 * The nine tools.
 *
 * Descriptions are written the way a person phrases the need, because that
 * phrasing is what the agent matches a user's request against. "Find a plumber
 * for a leak tomorrow" has to land on `search_providers` without the agent
 * having to reason about our data model.
 *
 * Every mutating tool is two-phase. Called without `confirmation_token` it
 * changes nothing and returns a summary; called with one it commits. That is
 * stated in each description so the agent knows to show the summary first.
 */

const CustomerDetailsSchema = z
  .object({
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    addressLine1: z.string().optional(),
    addressLine2: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postalCode: z.string().optional(),
    notes: z.string().optional(),
  })
  .describe("Only the fields the chosen business actually needs are passed on. The rest never leave Porter.");

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly readOnly: boolean;
  handle(engine: BookingEngine, actor: Actor, args: any, signal: AbortSignal): Promise<unknown>;
}

const CONFIRM_NOTE =
  "Call this once without confirmation_token to get a summary of exactly what will happen, including the price and the cancellation policy. Show that summary to the user. Only call it again with the confirmation_token from that summary once they have agreed.";

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "search_providers",
    title: "Find local businesses",
    description:
      "Find local businesses that can do a job — a haircut, a manicure, a house cleaning, a plumber for a leak, someone to fix the AC. Use this first when the user wants something done but has not named a business. Returns ranked businesses with their next opening and what they charge.",
    readOnly: true,
    inputSchema: z.object({
      category: z
        .string()
        .describe("What the user needs, in their words: 'haircut', 'plumber', 'AC repair', 'deep clean'. Plain words work; you do not need an internal code."),
      location: z.string().optional().describe("Postal code or city the work is needed in."),
      time_window: z
        .object({ from: z.string().optional(), to: z.string().optional() })
        .optional()
        .describe("ISO 8601 timestamps, when the user cares about when. 'tomorrow' becomes a from/to pair."),
      budget_minor: z.number().int().optional().describe("Most the user wants to spend, in cents. $300 is 30000."),
      radius_km: z.number().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.searchProviders(actor, args, signal);
    },
  },
  {
    name: "get_availability",
    title: "See open appointment times",
    description:
      "See open appointment times for one business and one service. Use after search_providers, once the user has picked somewhere. Each slot comes back with a slot_id you pass to create_booking.",
    readOnly: true,
    inputSchema: z.object({
      provider_id: z.string(),
      service_id: z.string(),
      from: z.string().describe("ISO 8601 start of the range to look in."),
      to: z.string().describe("ISO 8601 end of the range to look in."),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.getAvailability(actor, args, signal);
    },
  },
  {
    name: "get_quote",
    title: "Get a price estimate",
    description:
      "Get a price estimate for a job that needs one before it can be booked — a plumbing repair, an HVAC problem, an electrical fault. Use this when a service came back marked quote_required. Describe the problem in the user's own words and include the address.",
    readOnly: true,
    inputSchema: z.object({
      provider_id: z.string(),
      job_description: z.string().describe("What is wrong, in the user's words. 'AC blowing warm air since yesterday.'"),
      address: CustomerDetailsSchema.describe("Where the work is needed. Only the address fields are used."),
      photo_urls: z.array(z.string()).optional().describe("Photos of the problem, if the user has any."),
      category: z.string().optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.getQuote(actor, args, signal);
    },
  },
  {
    name: "create_booking",
    title: "Book an appointment",
    description: `Book an appointment at a time found with get_availability. ${CONFIRM_NOTE}`,
    readOnly: false,
    inputSchema: z.object({
      slot_id: z.string().describe("From get_availability or a quote's offered_slots."),
      quote_id: z.string().optional(),
      customer_details: CustomerDetailsSchema,
      notes: z.string().optional().describe("Anything the business should know."),
      idempotency_key: z
        .string()
        .describe("A unique id you generate for this booking attempt. Reuse the SAME key if you retry, so the user is never booked twice."),
      confirmation_token: z.string().optional().describe("From the summary returned by the first call. Omit on the first call."),
    }),
    async handle(engine, actor, args, signal) {
      return engine.createBooking(actor, args, signal);
    },
  },
  {
    name: "reschedule_booking",
    title: "Move an appointment",
    description: `Move an existing appointment to a different time — "move my Thursday haircut to Friday afternoon". Find the new time with get_availability first. ${CONFIRM_NOTE}`,
    readOnly: false,
    inputSchema: z.object({
      booking_id: z.string(),
      new_slot_id: z.string(),
      idempotency_key: z.string(),
      confirmation_token: z.string().optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.rescheduleBooking(actor, args, signal);
    },
  },
  {
    name: "cancel_booking",
    title: "Cancel an appointment",
    description: `Cancel an appointment. The first call always returns any cancellation fee BEFORE anything is cancelled — show that fee to the user and let them decide. ${CONFIRM_NOTE}`,
    readOnly: false,
    inputSchema: z.object({
      booking_id: z.string(),
      reason: z.string().optional(),
      idempotency_key: z.string(),
      confirmation_token: z.string().optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.cancelBooking(actor, args, signal);
    },
  },
  {
    name: "list_my_bookings",
    title: "See the user's appointments",
    description:
      "See the user's upcoming and past appointments booked through Porter. Use this when they ask what they have coming up, or before rescheduling or cancelling, to find the booking_id.",
    readOnly: true,
    inputSchema: z.object({
      status: z.enum(["pending", "confirmed", "completed", "cancelled", "no_show"]).optional(),
    }),
    async handle(engine, actor, args) {
      return engine.listMyBookings(actor, args.status);
    },
  },
  {
    name: "pay_or_deposit",
    title: "Pay for a booking",
    description: `Pay for a booking, or put down the deposit a business requires. ${CONFIRM_NOTE}`,
    readOnly: false,
    inputSchema: z.object({
      booking_id: z.string(),
      idempotency_key: z.string(),
      confirmation_token: z.string().optional(),
    }),
    async handle(engine, actor, args, signal) {
      return engine.payOrDeposit(actor, args, signal);
    },
  },
  {
    name: "message_provider",
    title: "Message a business",
    description:
      "Send a short message to a business about an existing booking — running late, gate code, a detail they asked for. Not for booking changes; use reschedule_booking or cancel_booking for those.",
    readOnly: false,
    inputSchema: z.object({
      booking_id: z.string(),
      message: z.string().max(2000),
    }),
    async handle(engine, actor, args, signal) {
      return engine.messageProvider(actor, args, signal);
    },
  },
];

/**
 * Turn any failure into a structured result the agent can explain.
 *
 * Errors come back as content plus `isError`, not as a transport fault, so the
 * agent can tell the user what happened and what to do next. Raw provider text
 * never appears here — it is untrusted, and PorterError carries only our own
 * wording plus structured details.
 */
export function toErrorResult(error: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const payload = PorterError.is(error)
    ? { error: error.toPublic() }
    : { error: { code: "ADAPTER_DOWN", message: "Something went wrong on our side. Try again in a moment.", details: {} } };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}
