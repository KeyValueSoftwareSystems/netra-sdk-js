import {
  Tracer,
  Span,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import {
  extractQuery,
  setQueryAttributes,
  setResultAttributes,
  extractDatabaseName,
} from "./utils";

const QUERY_SPAN_NAME = "typeorm.query";
const MANAGER_QUERY_SPAN_NAME = "typeorm.manager.query";
const REPOSITORY_QUERY_SPAN_NAME = "typeorm.repository.query";

type WrappedFunction = (...args: unknown[]) => unknown;

export function queryWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[]
  ): unknown {
    const queryInfo = extractQuery(args[0] as string | { query: string; parameters?: any[] });
    const parameters = args[1] as any[] | undefined || queryInfo.parameters;

    return tracer.startActiveSpan(
      QUERY_SPAN_NAME,
      { kind: SpanKind.CLIENT },
      (span: Span) => {
        try {
          const dbName = extractDatabaseName(instance);
          if (dbName) {
            span.setAttribute("db.name", dbName);
          }

          setQueryAttributes(span, queryInfo.sql, parameters);

          const startTime = Date.now();
          const result = wrapped.call(instance, ...args);
          const endTime = Date.now();

          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<any>)
              .then((res) => {
                setResultAttributes(span, res);
                span.setAttribute("db.duration", (Date.now() - startTime) / 1000);
                span.setStatus({ code: SpanStatusCode.OK });
                return res;
              })
              .catch((error) => {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error instanceof Error ? error.message : String(error),
                });
                span.recordException(error as Error);
                throw error;
              })
              .finally(() => {
                span.end();
              });
          } else {
            setResultAttributes(span, result);
            span.setAttribute("db.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      }
    );
  };
}

export function managerQueryWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[]
  ): unknown {
    const queryInfo = extractQuery(args[0] as string | { query: string; parameters?: any[] });
    const parameters = args[1] as any[] | undefined || queryInfo.parameters;

    return tracer.startActiveSpan(
      MANAGER_QUERY_SPAN_NAME,
      { kind: SpanKind.CLIENT },
      (span: Span) => {
        try {
          const manager = instance as any;
          const connection = manager.connection || manager.dataSource;
          const dbName = extractDatabaseName(connection);
          if (dbName) {
            span.setAttribute("db.name", dbName);
          }

          setQueryAttributes(span, queryInfo.sql, parameters);

          const startTime = Date.now();
          const result = wrapped.call(instance, ...args);
          const endTime = Date.now();

          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<any>)
              .then((res) => {
                setResultAttributes(span, res);
                span.setAttribute("db.duration", (Date.now() - startTime) / 1000);
                span.setStatus({ code: SpanStatusCode.OK });
                return res;
              })
              .catch((error) => {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error instanceof Error ? error.message : String(error),
                });
                span.recordException(error as Error);
                throw error;
              })
              .finally(() => {
                span.end();
              });
          } else {
            setResultAttributes(span, result);
            span.setAttribute("db.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      }
    );
  };
}

export function repositoryQueryWrapper(tracer: Tracer) {
  return function wrapper(
    wrapped: WrappedFunction,
    instance: unknown,
    args: unknown[]
  ): unknown {
    const queryInfo = extractQuery(args[0] as string | { query: string; parameters?: any[] });
    const parameters = args[1] as any[] | undefined || queryInfo.parameters;

    return tracer.startActiveSpan(
      REPOSITORY_QUERY_SPAN_NAME,
      { kind: SpanKind.CLIENT },
      (span: Span) => {
        try {
          const repository = instance as any;
          const manager = repository.manager;
          const connection = manager?.connection || manager?.dataSource;
          const dbName = extractDatabaseName(connection);
          if (dbName) {
            span.setAttribute("db.name", dbName);
          }

          if (repository.metadata) {
            span.setAttribute("db.typeorm.entity", repository.metadata.name);
            if (repository.metadata.tableName) {
              span.setAttribute("db.sql.table", repository.metadata.tableName);
            }
          }

          setQueryAttributes(span, queryInfo.sql, parameters);

          const startTime = Date.now();
          const result = wrapped.call(instance, ...args);
          const endTime = Date.now();

          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<any>)
              .then((res) => {
                setResultAttributes(span, res);
                span.setAttribute("db.duration", (Date.now() - startTime) / 1000);
                span.setStatus({ code: SpanStatusCode.OK });
                return res;
              })
              .catch((error) => {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: error instanceof Error ? error.message : String(error),
                });
                span.recordException(error as Error);
                throw error;
              })
              .finally(() => {
                span.end();
              });
          } else {
            setResultAttributes(span, result);
            span.setAttribute("db.duration", (endTime - startTime) / 1000);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          }
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      }
    );
  };
}

