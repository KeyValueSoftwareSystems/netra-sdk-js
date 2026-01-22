/**
 * Context Store for Session Isolation
 *
 * Uses Node.js AsyncLocalStorage to provide per-request context isolation.
 * This ensures concurrent requests (e.g., in LangGraph apps) don't interfere
 * with each other's session state.
 */

import { AsyncLocalStorage } from "async_hooks";
import { Span, Context as OtelContext } from "@opentelemetry/api";

/**
 * Session context that holds all per-request state.
 * Each concurrent request gets its own isolated instance.
 */
export interface SessionContext {
  // Session identifiers
  sessionId?: string;
  userId?: string;
  tenantId?: string;

  // Entity stacks (per-request isolation)
  workflowStack: string[];
  taskStack: string[];
  agentStack: string[];
  spanStack: string[];

  // Span tracking (per-request)
  currentSpan?: Span;
  rootSpan?: Span;
  spansByName: Map<string, Span[]>;
  activeSpans: Span[];

  // Custom attributes
  customAttributes: Map<string, string>;

  // LangGraph-specific context (optional, set by LangGraph wrappers)
  langgraph?: {
    otelContextStack: OtelContext[];
  };
}

/**
 * ContextStore provides AsyncLocalStorage-based context isolation.
 *
 * This is the foundation for concurrency-safe session management.
 * All session state should be stored in SessionContext and accessed
 * through ContextStore methods.
 */
export class ContextStore {
  private static asyncLocalStorage = new AsyncLocalStorage<SessionContext>();

  /**
   * A fallback context used when no AsyncLocalStorage context exists.
   * This maintains backward compatibility for single-request scenarios
   * where runWithContext() is not explicitly called.
   */
  private static fallbackContext: SessionContext | undefined;

  /**
   * Creates a new empty session context with all required fields initialized.
   */
  static createContext(): SessionContext {
    return {
      sessionId: undefined,
      userId: undefined,
      tenantId: undefined,
      workflowStack: [],
      taskStack: [],
      agentStack: [],
      spanStack: [],
      currentSpan: undefined,
      rootSpan: undefined,
      spansByName: new Map(),
      activeSpans: [],
      customAttributes: new Map(),
    };
  }

  /**
   * Gets the current context from AsyncLocalStorage.
   * Returns undefined if no context has been established.
   */
  static getContext(): SessionContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Gets the current context or creates a fallback context.
   * The fallback maintains backward compatibility for code that
   * doesn't explicitly use runWithContext().
   *
   * In concurrent scenarios, always use runWithContext() to ensure
   * proper isolation between requests.
   */
  static getOrCreateContext(): SessionContext {
    const ctx = this.asyncLocalStorage.getStore();
    if (ctx) {
      return ctx;
    }

    // Fallback for backward compatibility
    if (!this.fallbackContext) {
      this.fallbackContext = this.createContext();
    }
    return this.fallbackContext;
  }

  /**
   * Runs a function with the given context.
   * All code executed within fn (including async operations)
   * will have access to this context via getContext().
   *
   * @param context The session context to use
   * @param fn The function to execute
   * @returns The return value of fn
   */
  static runWithContext<T>(context: SessionContext, fn: () => T): T {
    return this.asyncLocalStorage.run(context, fn);
  }

  /**
   * Runs a function with a new, isolated context.
   * This is the recommended entry point for request handlers
   * to ensure session isolation.
   *
   * @param fn The function to execute
   * @returns The return value of fn
   */
  static runWithNewContext<T>(fn: () => T): T {
    const context = this.createContext();
    return this.asyncLocalStorage.run(context, fn);
  }

  /**
   * Clears the fallback context.
   * Useful for testing or when you want to reset global state.
   */
  static clearFallbackContext(): void {
    this.fallbackContext = undefined;
  }

  /**
   * Checks if we're currently running inside an AsyncLocalStorage context.
   * Returns true if a proper context exists, false if using fallback.
   */
  static hasContext(): boolean {
    return this.asyncLocalStorage.getStore() !== undefined;
  }
}
