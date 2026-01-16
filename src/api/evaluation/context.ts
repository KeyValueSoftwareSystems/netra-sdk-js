/**
 * Run Entry Context for Evaluation
 * Provides context management for evaluation run entries
 */

import { context, Span, SpanKind, trace } from "@opentelemetry/api";
import { Config } from "../../config";
import { EvaluationHttpClient } from "./client";
import { DatasetItem, EntryStatus, EvaluationScore, Run } from "./models";

export class RunEntryContext {
  private client: EvaluationHttpClient;
  private config: Config;
  readonly evaluationRun: Run;
  readonly entry: DatasetItem;
  traceId?: string;
  private span?: Span;
  private startTime?: Date;

  constructor(
    client: EvaluationHttpClient,
    config: Config,
    run: Run,
    entry: DatasetItem
  ) {
    this.client = client;
    this.config = config;
    this.evaluationRun = run;
    this.entry = entry;
  }

  /**
   * Get the run associated with this context
   * Alias for evaluationRun for backwards compatibility
   */
  get run(): Run {
    return this.evaluationRun;
  }

  /**
   * Start the run entry context
   * Creates a span and posts agent_triggered status
   */
  async start(): Promise<void> {
    this.startTime = new Date();

    // Create a span for this entry
    const tracer = trace.getTracer("netra.evaluation");
    this.span = tracer.startSpan(`evaluation.run.${this.evaluationRun.id}.entry.${this.entry.id}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        "netra.evaluation.run_id": this.evaluationRun.id,
        "netra.evaluation.entry_id": this.entry.id,
        "netra.evaluation.dataset_id": this.evaluationRun.datasetId,
      },
    });

    // Get trace ID from the span
    const spanContext = this.span.spanContext();
    this.traceId = spanContext.traceId;

    // Post agent_triggered status
    await this.client.postEntryStatus(
      this.evaluationRun.id,
      this.entry.id,
      EntryStatus.AGENT_TRIGGERED,
      this.traceId
    );
  }

  /**
   * End the run entry context
   * @param success Whether the entry completed successfully
   * @param scores Optional scores to record
   */
  async end(success: boolean = true, scores?: EvaluationScore[]): Promise<void> {
    const status = success ? EntryStatus.AGENT_COMPLETED : EntryStatus.FAILED;

    await this.client.postEntryStatus(
      this.evaluationRun.id,
      this.entry.id,
      status,
      this.traceId,
      undefined, // sessionId
      scores
    );

    if (this.span) {
      this.span.end();
    }
  }

  /**
   * Get the current span
   */
  getSpan(): Span | undefined {
    return this.span;
  }

  /**
   * Execute a function within this context
   * Automatically handles start/end and error handling
   */
  async execute<T>(
    fn: (ctx: RunEntryContext) => Promise<T>,
    scores?: EvaluationScore[]
  ): Promise<T> {
    await this.start();

    try {
      const result = await fn(this);
      await this.end(true, scores);
      return result;
    } catch (error) {
      await this.end(false);
      throw error;
    }
  }
}
