/**
 * The adapter contract.
 *
 * The interface itself lives in `@porter/core`, because it is written in terms
 * of the core domain types and core's engine calls it — keeping it there is
 * what stops the two packages depending on each other in a cycle.
 *
 * This package exists for the part that cannot live in core: the conformance
 * suite, which every adapter must pass. Adapters depend on this package; core
 * does not.
 */
export type {
  AdapterCapabilities,
  AdapterContext,
  AvailabilityQuery,
  CancelRequest,
  CancellationValidation,
  CancellationValidationRequest,
  CreateBookingRequest,
  ListQuery,
  MessageReceipt,
  MessageRequest,
  ProviderAdapter,
  QuoteRequest,
  RescheduleRequest,
  RescheduleValidationRequest,
  RescheduleValidation,
  ServiceDescription,
  SearchQuery,
  SearchResult,
  Provider,
  Service,
  Slot,
  SlotHold,
  Quote,
  Booking,
  CancellationPolicy,
  CustomerDetails,
  CustomerField,
} from "@porter/core";

export { runAdapterConformance, makeContext, type ConformanceFixtures } from "./conformance.js";
