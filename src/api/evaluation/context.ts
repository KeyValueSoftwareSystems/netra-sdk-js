/**
 * Run Entry Context for Evaluation
 * Provides context management for evaluation run entries
 */

import { Span, SpanKind, trace } from "@opentelemetry/api";
import { Config } from "../../config";
import { EvaluationHttpClient } from "./client";
import { DatasetEntry, EntryStatus, EvaluationScore, Run } from "./models";

export class RunEntryContext {
  private client: EvaluationHttpClient;
  private config: Config;
  readonly evaluationRun: Run;
  readonly entry: DatasetEntry;
  traceId?: string;
  private span?: Span;
  private startTime?: Date;

  constructor(
    client: EvaluationHttpClient,
    config: Config,
    run: Run,
    entry: DatasetEntry,
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
    this.span = tracer.startSpan(
      `evaluation.run.${this.evaluationRun.id}.entry.${this.entry.id}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "netra.evaluation.runId": this.evaluationRun.id,
          "netra.evaluation.entryId": this.entry.id,
          "netra.evaluation.datasetId": this.evaluationRun.datasetId,
        },
      },
    );

    // Get trace ID from the span
    const spanContext = this.span.spanContext();
    this.traceId = spanContext.traceId;

    // Post agent_triggered status using postRunItem
    const payload = {
      traceId: this.traceId,
      datasetItemId: this.entry.id,
      status: EntryStatus.AGENT_TRIGGERED,
    };

    await this.client.postRunItem(this.evaluationRun.id, payload);
  }

  /**
   * End the run entry context
   * @param success Whether the entry completed successfully
   * @param scores Optional scores to record
   */
  async end(
    success: boolean = true,
    scores?: EvaluationScore[],
  ): Promise<void> {
    const status = success ? EntryStatus.AGENT_COMPLETED : EntryStatus.FAILED;

    // Post completed/failed status using postRunItem
    const payload: Record<string, any> = {
      traceId: this.traceId,
      datasetItemId: this.entry.id,
      status: status,
    };

    if (scores) {
      payload.scores = scores;
    }

    await this.client.postRunItem(this.evaluationRun.id, payload);

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
    scores?: EvaluationScore[],
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
