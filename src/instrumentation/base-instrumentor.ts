import { createRequire } from "module";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../logger";

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

/**
 * Shared lifecycle for Netra SDK instrumentors.
 *
 * Subclasses define three things:
 *   1. extractClasses  — pull patchable classes from a loaded module
 *   2. applyPatches    — wrap prototype methods
 *   3. removePatches   — unwrap (inverse of applyPatches)
 *
 * The base class owns:
 *   - ESM + CJS module resolution with dedup
 *   - Concurrency guard (single in-flight promise)
 *   - isInstrumented flag lifecycle
 *   - Tracer initialization
 *   - Consistent logging
 */
export abstract class BaseInstrumentor<TClasses> {
  private _isInstrumented = false;
  private _instrumentPromise: Promise<this> | null = null;
  private _resolvedClasses: TClasses[] = [];

  protected _tracer: Tracer | null = null;
  protected _tracerProvider?: TracerProvider;

  protected abstract readonly instrumentationName: string;
  protected abstract readonly instrumentationVersion: string;

  /**
   * The npm package name to resolve (used for ESM import and CJS require).
   * Set to null to skip the default resolution and override resolveClasses().
   */
  protected abstract readonly packageName: string;

  /**
   * Human-readable label for log messages (e.g. "Google GenAI").
   */
  protected abstract readonly displayName: string;

  /**
   * Extract patchable classes from a loaded module.
   * Return null if the module doesn't expose the expected API.
   */
  protected abstract extractClasses(mod: any): TClasses | null;

  /**
   * Apply instrumentation wrappers to one resolved class set.
   * Return true if at least one method was successfully wrapped.
   */
  protected abstract applyPatches(classes: TClasses, tracer: Tracer): boolean;

  /**
   * Remove instrumentation wrappers (inverse of applyPatches).
   */
  protected abstract removePatches(classes: TClasses): void;

  /**
   * Check whether two resolved class sets refer to the same module load.
   * Default: reference equality. Override for composite class objects.
   */
  protected isSameClasses(a: TClasses, b: TClasses): boolean {
    return a === b;
  }

  /**
   * Optional hook called during uninstrument() after prototype unwrapping.
   * Use for extra cleanup (e.g. restoring patched instance methods).
   */
  protected onUninstrument(): void {}

  get tracer(): Tracer | null {
    return this._tracer;
  }

  isInstrumented(): boolean {
    return this._isInstrumented;
  }

  get resolvedClasses(): ReadonlyArray<TClasses> {
    return this._resolvedClasses;
  }

  async instrument(options: InstrumentorOptions = {}): Promise<this> {
    if (this._isInstrumented) {
      Logger.warn(`${this.displayName} is already instrumented`);
      return this;
    }

    if (this._instrumentPromise) {
      return this._instrumentPromise;
    }

    this._instrumentPromise = this._doInstrument(options);
    try {
      return await this._instrumentPromise;
    } finally {
      this._instrumentPromise = null;
    }
  }

  uninstrument(): void {
    this._instrumentPromise = null;

    if (!this._isInstrumented) {
      Logger.warn(`${this.displayName} is not instrumented`);
      return;
    }

    for (const classes of this._resolvedClasses) {
      try {
        this.removePatches(classes);
      } catch (error) {
        Logger.error(`${this.displayName}: failed to remove patches: ${error}`);
      }
    }

    this.onUninstrument();

    this._resolvedClasses = [];
    this._isInstrumented = false;
  }

  private async _doInstrument(options: InstrumentorOptions): Promise<this> {
    const classSets = await this.resolveClasses();
    if (classSets.length === 0) {
      return this;
    }

    // Re-check after the async boundary
    if (this._isInstrumented) {
      return this;
    }

    try {
      this._tracerProvider = options.tracerProvider;
      this._tracer = this._tracerProvider
        ? this._tracerProvider.getTracer(
            this.instrumentationName,
            this.instrumentationVersion,
          )
        : trace.getTracer(
            this.instrumentationName,
            this.instrumentationVersion,
          );
    } catch (error) {
      Logger.error(`${this.displayName}: failed to initialize tracer: ${error}`);
      return this;
    }

    let anyWrapped = false;
    for (const classes of classSets) {
      try {
        if (this.applyPatches(classes, this._tracer)) {
          anyWrapped = true;
        }
      } catch (error) {
        Logger.error(`${this.displayName}: patch failed: ${error}`);
      }
    }

    if (anyWrapped) {
      this._isInstrumented = true;
    }
    return this;
  }

  /**
   * Resolve the target package via ESM import() and CJS createRequire().
   * Override this for non-standard resolution strategies.
   */
  protected async resolveClasses(): Promise<TClasses[]> {
    if (this._resolvedClasses.length > 0) return this._resolvedClasses;

    // ESM
    try {
      // @ts-ignore — peer dependency may not be installed
      const mod = await import(this.packageName);
      const classes = this.extractClasses(mod);
      if (classes) {
        this._resolvedClasses.push(classes);
      }
    } catch {
      Logger.debug(`${this.displayName}: ESM import not available`);
    }

    // CJS
    try {
      const req = createRequire(import.meta.url);
      const mod = req(this.packageName);
      const classes = this.extractClasses(mod);
      if (classes) {
        const isDuplicate = this._resolvedClasses.some((existing) =>
          this.isSameClasses(existing, classes),
        );
        if (!isDuplicate) {
          this._resolvedClasses.push(classes);
        }
      }
    } catch {
      Logger.debug(`${this.displayName}: CJS require not available`);
    }

    return this._resolvedClasses;
  }
}
