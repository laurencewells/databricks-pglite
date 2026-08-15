import { randomUUID } from "node:crypto";
import type {
  Application,
  NextFunction,
  Request,
  Response,
} from "express";
import { z } from "zod";
import {
  normalizeQueryResult,
  snapshotPortableSqlParameters,
} from "../shared/queryable.js";
import type { DatabaseService } from "./database.js";
import { requestIdentity } from "./identity.js";
import {
  MutationsQuiescingError,
  type MutationDrain,
} from "./mutation-drain.js";

type TrustedSqlDatabase = Pick<DatabaseService, "query">;
type TrustedSqlMutations = Pick<MutationDrain, "run">;

export interface TrustedSqlDependencies {
  environment: string;
  allowLocalIdentity?: boolean;
  database: TrustedSqlDatabase;
  mutations: TrustedSqlMutations;
}

const queryInput = z
  .object({
    text: z.string().trim().min(1).max(8_192),
    values: z.array(z.unknown()).default([]),
  })
  .strict();

export function registerTrustedSqlRoute(
  app: Application,
  dependencies: TrustedSqlDependencies,
): void {
  app.post(
    "/api/v1/sql/query",
    asyncRoute(async (request, response) => {
      const identity = requestIdentity(
        request.headers,
        dependencies.environment,
        dependencies.environment === "production"
          ? false
          : dependencies.allowLocalIdentity,
      );

      const parsed = queryInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid SQL query request" });
        return;
      }
      let values;
      try {
        values = snapshotPortableSqlParameters(parsed.data.values);
      } catch {
        response.status(400).json({ error: "Invalid SQL query request" });
        return;
      }

      const requestId = randomUUID();
      const startedAt = Date.now();
      let outcome: "failure" | "success" = "failure";
      try {
        const result = await dependencies.mutations.run(() =>
          dependencies.database.query(parsed.data.text, values),
        );
        response.json(normalizeQueryResult(result));
        outcome = "success";
      } catch (error) {
        if (error instanceof MutationsQuiescingError) throw error;
        throw new TrustedSqlExecutionError(requestId);
      } finally {
        console.info({
          requestId,
          callerId: identity.id,
          durationMs: Date.now() - startedAt,
          outcome,
        });
      }
    }),
  );
}

class TrustedSqlExecutionError extends Error {
  constructor(readonly requestId: string) {
    super("Trusted SQL query failed");
    this.name = "TrustedSqlExecutionError";
  }
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}
