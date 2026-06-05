import { Span } from "@opentelemetry/api";
import { Logger } from "../../logger";

export function extractQuery(query: string | { query: string; parameters?: any[] }): {
  sql: string;
  parameters?: any[];
} {
  if (typeof query === "string") {
    return { sql: query };
  }
  if (query && typeof query === "object" && "query" in query) {
    return {
      sql: String(query.query),
      parameters: Array.isArray(query.parameters) ? query.parameters : undefined,
    };
  }
  return { sql: String(query) };
}
export function sanitizeQuery(sql: string, maxLength: number = 5000): string {
  if (sql.length <= maxLength) {
    return sql;
  }
  return sql.substring(0, maxLength) + "...";
}

export function setQueryAttributes(
  span: Span,
  sql: string,
  parameters?: any[],
  operation?: string
): void {
  span.setAttribute("db.system", "typeorm");
  span.setAttribute("db.type", "sql");
  
  if (operation) {
    span.setAttribute("db.operation", operation);
  }

  if (!operation) {
    const upperSql = sql.trim().toUpperCase();
    if (upperSql.startsWith("SELECT")) {
      span.setAttribute("db.operation", "SELECT");
    } else if (upperSql.startsWith("INSERT")) {
      span.setAttribute("db.operation", "INSERT");
    } else if (upperSql.startsWith("UPDATE")) {
      span.setAttribute("db.operation", "UPDATE");
    } else if (upperSql.startsWith("DELETE")) {
      span.setAttribute("db.operation", "DELETE");
    } else if (upperSql.startsWith("CREATE")) {
      span.setAttribute("db.operation", "CREATE");
    } else if (upperSql.startsWith("DROP")) {
      span.setAttribute("db.operation", "DROP");
    } else if (upperSql.startsWith("ALTER")) {
      span.setAttribute("db.operation", "ALTER");
    }
  }

  span.setAttribute("db.statement", sanitizeQuery(sql));

  if (parameters && parameters.length > 0) {
    try {
      span.setAttribute("db.statement.parameters", JSON.stringify(parameters));
    } catch (e) {
      Logger.log(e);
    }
  }
}

export function setResultAttributes(
  span: Span,
  result: any,
  rowCount?: number
): void {
  if (rowCount !== undefined) {
    span.setAttribute("db.rows_affected", rowCount);
  } else if (result !== undefined && result !== null) {
    if (Array.isArray(result)) {
      span.setAttribute("db.rows_affected", result.length);
    } else if (typeof result === "object" && "affected" in result) {
      span.setAttribute("db.rows_affected", Number(result.affected) || 0);
    } else if (typeof result === "number") {
      span.setAttribute("db.rows_affected", result);
    }
  }
}

export function extractDatabaseName(dataSource: any): string | undefined {
  if (!dataSource) return undefined;
  
  const options = dataSource.options || dataSource.connectionOptions;
  if (options) {
    if (options.database) return String(options.database);
    if (options.url) {
      try {
        const url = new URL(options.url);
        const dbName = url.pathname?.replace(/^\//, "");
        if (dbName) return dbName;
      } catch(e) {
        Logger.log(e);
      }
    }
  }
  
  return undefined;
}

