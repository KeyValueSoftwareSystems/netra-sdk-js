import {
  Baggage,
  Context,
  propagation,
  SpanKind,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
  trace,
} from "@opentelemetry/api";
import { W3CBaggagePropagator } from "@opentelemetry/core";
import { NetraLogger } from "../netraLogger";
import {
  contextWithSessionValues,
  CUSTOM_BAGGAGE_PREFIX,
  CUSTOM_KEYS_BAGGAGE_KEY,
  getSessionValues,
  SessionKey,
} from "../processors/session-span-processor";

const RESERVED_BAGGAGE_PREFIX = "netra.";
const SESSION_BAGGAGE_KEYS: readonly SessionKey[] = ["session_id", "user_id", "tenant_id"];

export interface BaggagePolicy {
  propagateHosts: string[];
  trustInbound: boolean;
}

let policy: BaggagePolicy = { propagateHosts: [], trustInbound: false };
let inboundIdentityNoticeLogged = false;

export function configureBaggagePolicy(next: Partial<BaggagePolicy>): void {
  policy = {
    propagateHosts: (next.propagateHosts ?? []).map((h) => h.toLowerCase()).filter(Boolean),
    trustInbound: next.trustInbound === true,
  };
  inboundIdentityNoticeLogged = false;
}

function isReservedKey(key: string): boolean {
  return key.toLowerCase().startsWith(RESERVED_BAGGAGE_PREFIX);
}

function isSessionKey(key: string): key is SessionKey {
  return (SESSION_BAGGAGE_KEYS as readonly string[]).includes(key);
}

function isCustomKey(key: string): boolean {
  return key === CUSTOM_KEYS_BAGGAGE_KEY || key.startsWith(CUSTOM_BAGGAGE_PREFIX);
}

function isIdentityKey(key: string): boolean {
  return isSessionKey(key) || isCustomKey(key);
}

function withoutEntries(ctx: Context, baggage: Baggage, keys: string[]): Context {
  if (keys.length === 0) return ctx;
  const cleaned = baggage.removeEntries(...keys);
  return cleaned.getAllEntries().length > 0
    ? propagation.setBaggage(ctx, cleaned)
    : propagation.deleteBaggage(ctx);
}

function keysWhere(baggage: Baggage, test: (key: string) => boolean): string[] {
  return baggage
    .getAllEntries()
    .map(([key]) => key)
    .filter(test);
}

export function stripReservedBaggage(ctx: Context): Context {
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) return ctx;
  return withoutEntries(ctx, baggage, keysWhere(baggage, isReservedKey));
}

function hostnameOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

// Destination host from the client span the http/undici instrumentations start before injecting.
function destinationHost(ctx: Context): string | undefined {
  const span = trace.getSpan(ctx) as any;
  if (span?.kind !== SpanKind.CLIENT && span?.kind !== SpanKind.PRODUCER) return undefined;
  const attrs = span.attributes as Record<string, unknown> | undefined;
  if (!attrs) return undefined;
  const fromUrl = hostnameOf(attrs["url.full"]) ?? hostnameOf(attrs["http.url"]);
  if (fromUrl) return fromUrl;
  for (const key of ["server.address", "net.peer.name"]) {
    const host = attrs[key];
    if (typeof host === "string" && host) return host;
  }
  return undefined;
}

export function isBaggageHostAllowed(host: string | undefined): boolean {
  if (!host || policy.propagateHosts.length === 0) return false;
  const normalizedHost = host.toLowerCase().replace(/\.+$/, "");
  if (!normalizedHost) return false;
  return policy.propagateHosts.some(
    (entry) => normalizedHost === entry || normalizedHost.endsWith(`.${entry}`),
  );
}

function logInboundIdentityIgnored(keys: string[]): void {
  if (inboundIdentityNoticeLogged) return;
  inboundIdentityNoticeLogged = true;
  NetraLogger.notice(
    "warn",
    `A calling service sent a user, session, tenant or custom attributes (${[...keys].sort().join(", ")}), which was not used. To record requests under the values your own services send, set NETRA_TRUST_INBOUND_BAGGAGE=true on this service. This message is shown once.`,
  );
}

export class NetraBaggagePropagator implements TextMapPropagator {
  private readonly inner = new W3CBaggagePropagator();

  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    let out = stripReservedBaggage(ctx);
    const baggage = propagation.getBaggage(out) ?? propagation.createBaggage();

    if (isBaggageHostAllowed(destinationHost(ctx))) {
      let withIdentity = baggage;
      for (const [key, value] of Object.entries(getSessionValues(ctx))) {
        if (value) withIdentity = withIdentity.setEntry(key, { value });
      }
      if (withIdentity.getAllEntries().length > 0) {
        out = propagation.setBaggage(out, withIdentity);
      }
    } else {
      out = withoutEntries(out, baggage, keysWhere(baggage, isIdentityKey));
    }

    this.inner.inject(out, carrier, setter);
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const extracted = this.inner.extract(ctx, carrier, getter);
    const baggage = propagation.getBaggage(extracted);
    if (!baggage || baggage === propagation.getBaggage(ctx)) {
      return stripReservedBaggage(extracted);
    }

    const identityKeys = keysWhere(baggage, isIdentityKey);
    let out = extracted;

    if (identityKeys.length > 0 && policy.trustInbound) {
      const sessionKeys = identityKeys.filter(isSessionKey);
      const session: Partial<Record<SessionKey, string>> = {};
      for (const key of sessionKeys) session[key] = baggage.getEntry(key)?.value;
      out = contextWithSessionValues(out, session);
      out = withoutEntries(out, baggage, sessionKeys);
    } else if (identityKeys.length > 0) {
      logInboundIdentityIgnored(identityKeys);
      out = withoutEntries(out, baggage, identityKeys);
    }

    return stripReservedBaggage(out);
  }

  fields(): string[] {
    return this.inner.fields();
  }
}
