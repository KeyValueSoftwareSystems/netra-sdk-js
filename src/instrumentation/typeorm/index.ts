import {
  queryWrapper,
  managerQueryWrapper,
  repositoryQueryWrapper,
} from "./wrappers";
import { __version__ } from "./version";
import { trace, Tracer, TracerProvider } from "@opentelemetry/api";
import { Logger } from "../../logger";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const INSTRUMENTATION_NAME = "netra.instrumentation.typeorm";
const originalMethods: Map<string, Function> = new Map();
let isInstrumented = false;

export interface InstrumentorOptions {
  tracerProvider?: TracerProvider;
}

export class NetraTypeORMInstrumentor {
  private tracer?: Tracer;
  private tracerProvider?: TracerProvider;

  constructor() {
  }

  async instrument(options: InstrumentorOptions = {}): Promise<NetraTypeORMInstrumentor> {
    if (isInstrumented) {
      Logger.warn("TypeORM is already instrumented");
      return this;
    }
    try {
      this.tracerProvider = options.tracerProvider;
      this.tracer = this.tracerProvider ? this.tracerProvider.getTracer(INSTRUMENTATION_NAME, __version__) : trace.getTracer(INSTRUMENTATION_NAME, __version__);
    } catch (error) {
      Logger.error(`Failed to initialize tracer: ${error}`);
      return this;
    }
    await this._instrumentDataSource();
    await this._instrumentEntityManager();
    await this._instrumentRepository();
    isInstrumented = true;
    return this;
  }

  uninstrument(): void {
    if (!isInstrumented) {
      Logger.warn("TypeORM is not instrumented");
      return;
    }
    this._uninstrumentDataSource().catch(() => {
    });
    this._uninstrumentEntityManager().catch(() => {
    });
    this._uninstrumentRepository().catch(() => {
    });

    originalMethods.clear();
    isInstrumented = false;
  }

  isInstrumented(): boolean {
    return isInstrumented;
  }

  private async _instrumentDataSource(): Promise<void> {
    if (!this.tracer) return;

    try {
      const typeorm = require("typeorm");
      const DataSource = typeorm.DataSource || (typeorm as any).default?.DataSource;
      if (!DataSource) {
        if (this.tracerProvider) {
          Logger.debug("TypeORM DataSource not found, skipping instrumentation");
        }
        return;
      }

      if (DataSource.prototype?.query) {
        const originalQuery = DataSource.prototype.query;
        originalMethods.set("DataSource.prototype.query", originalQuery);
        const tracer = this.tracer;
        const wrapper = queryWrapper(tracer);
        DataSource.prototype.query = function (
          this: unknown,
          ...args: unknown[]
        ): any {
          const original = originalQuery.bind(this);
          return wrapper(original as any, this, args);
        };
      }
    } catch (error) {
      Logger.debug(`Failed to instrument DataSource: ${error}`);
    }
  }

  private async _instrumentEntityManager(): Promise<void> {
    if (!this.tracer) return;

    try {
      const typeorm = require("typeorm");
      const EntityManager = typeorm.EntityManager || (typeorm as any).default?.EntityManager;
      if (!EntityManager) {
        if (this.tracerProvider) {
          Logger.debug("TypeORM EntityManager not found, skipping instrumentation");
        }
        return;
      }
      if (EntityManager.prototype?.query) {
        const originalQuery = EntityManager.prototype.query;
        originalMethods.set("EntityManager.prototype.query", originalQuery);

        const tracer = this.tracer;
        const wrapper = managerQueryWrapper(tracer);

        EntityManager.prototype.query = function (
          this: unknown,
          ...args: unknown[]
        ): any {
          const original = originalQuery.bind(this);
          return wrapper(original as any, this, args);
        };
      }
    } catch (error) {
      Logger.debug(`Failed to instrument EntityManager: ${error}`);
    }
  }

  private async _instrumentRepository(): Promise<void> {
    if (!this.tracer) return;

    try {
      const typeorm = require("typeorm");
      const Repository = typeorm.Repository || (typeorm as any).default?.Repository;

      if (!Repository) {
        if (this.tracerProvider) {
          Logger.debug("TypeORM Repository not found, skipping instrumentation");
        }
        return;
      }

      if (Repository.prototype?.query) {
        const originalQuery = Repository.prototype.query;
        originalMethods.set("Repository.prototype.query", originalQuery);

        const tracer = this.tracer;
        const wrapper = repositoryQueryWrapper(tracer);

        Repository.prototype.query = function (
          this: unknown,
          ...args: unknown[]
        ): any {
          const original = originalQuery.bind(this);
          return wrapper(original as any, this, args);
        };
      }
    } catch (error) {
      Logger.debug(`Failed to instrument Repository: ${error}`);
    }
  }

  private async _uninstrumentDataSource(): Promise<void> {
    try {
      const typeorm = require("typeorm");
      const DataSource = typeorm.DataSource || (typeorm as any).default?.DataSource;

      const originalQuery = originalMethods.get("DataSource.prototype.query");
      if (originalQuery && DataSource?.prototype) {
        DataSource.prototype.query = originalQuery as any;
      }
    } catch (error) {
      Logger.debug(`Failed to uninstrument DataSource: ${error}`);
    }
  }

  private async _uninstrumentEntityManager(): Promise<void> {
    try {
      const typeorm = require("typeorm");
      const EntityManager = typeorm.EntityManager || (typeorm as any).default?.EntityManager;
      const originalQuery = originalMethods.get("EntityManager.prototype.query");
      if (originalQuery && EntityManager?.prototype) {
        EntityManager.prototype.query = originalQuery as any;
      }
    } catch (error) {
      Logger.debug(`Failed to uninstrument EntityManager: ${error}`);
    }
  }

  private async _uninstrumentRepository(): Promise<void> {
    try {
      const typeorm = require("typeorm");
      const Repository = typeorm.Repository || (typeorm as any).default?.Repository;
      const originalQuery = originalMethods.get("Repository.prototype.query");
      if (originalQuery && Repository?.prototype) {
        Repository.prototype.query = originalQuery as any;
      }
    } catch (error) {
      Logger.debug(`Failed to uninstrument Repository: ${error}`);
    }
  }
}

export const typeORMInstrumentor = new NetraTypeORMInstrumentor();

export {
  queryWrapper,
  managerQueryWrapper,
  repositoryQueryWrapper,
} from "./wrappers";

export {
  extractQuery,
  sanitizeQuery,
  setQueryAttributes,
  setResultAttributes,
  extractDatabaseName,
} from "./utils";

export { __version__ } from "./version";

