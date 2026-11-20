import {
  Context,
  propagation,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
} from "@opentelemetry/api";
import { W3CBaggagePropagator } from "@opentelemetry/core";

/** Baggage keys in this namespace are Netra-internal and never cross the wire. */
const RESERVED_BAGGAGE_PREFIX = "netra.";

function isReservedKey(key: string): boolean {
  return key.toLowerCase().startsWith(RESERVED_BAGGAGE_PREFIX);
}

/**
 * Returns `ctx` with every reserved (`netra.*`) baggage entry removed.
 */
export function stripReservedBaggage(ctx: Context): Context {
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) return ctx;

  const reserved = baggage
    .getAllEntries()
    .map(([key]) => key)
    .filter(isReservedKey);
  if (reserved.length === 0) return ctx;

  const cleaned = baggage.removeEntries(...reserved);
  return cleaned.getAllEntries().length > 0
    ? propagation.setBaggage(ctx, cleaned)
    : propagation.deleteBaggage(ctx);
}

/**
 * W3C Baggage propagator that drops Netra's reserved `netra.*` keys in both
 * directions (JS-SEC-001/002): a caller cannot send SDK control values, such
 * as span-blocking patterns, and none are forwarded to downstream hosts.
 * All other baggage passes through unchanged.
 */
export class NetraBaggagePropagator implements TextMapPropagator {
  private readonly inner = new W3CBaggagePropagator();

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    this.inner.inject(stripReservedBaggage(ctx), carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    return stripReservedBaggage(this.inner.extract(ctx, carrier, getter));
  }

  fields(): string[] {
    return this.inner.fields();
  }
}
