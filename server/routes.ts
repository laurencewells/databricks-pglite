import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import {
  BrowserTableNotFoundError,
  type DatabaseBrowser,
} from "./database-browser.js";
import type { DatabaseService } from "./database.js";
import {
  IdentityRequiredError,
  requestIdentity,
} from "./identity.js";
import {
  MutationsQuiescingError,
  type MutationDrain,
} from "./mutation-drain.js";
import type { SnapshotService } from "./snapshots/service.js";
import { registerTrustedSqlRoute } from "./trusted-sql.js";

type DatabaseRoutes = Pick<
  DatabaseService,
  "listNotes" | "addNote" | "query"
>;
type SnapshotRoutes = Pick<SnapshotService, "status" | "checkpoint">;
type BrowserRoutes = Pick<DatabaseBrowser, "catalog" | "rows">;
type MutationRoutes = Pick<MutationDrain, "run">;

export interface RouteDependencies {
  environment: string;
  allowLocalIdentity?: boolean;
  database: DatabaseRoutes;
  browser: BrowserRoutes;
  snapshots: SnapshotRoutes;
  mutations: MutationRoutes;
  webUiEnabled: boolean;
  checkpointIntervalMs: number;
}

const noteInput = z.object({
  body: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(500)),
});

const browserRowsQuery = z
  .object({
    schema: z.string().min(1).max(63),
    table: z.string().min(1).max(63),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export function registerRoutes(
  app: Application,
  dependencies: RouteDependencies,
): void {
  app.use(express.json({ limit: "16kb" }));

  app.get(
    "/api/app/status",
    asyncRoute(async (request, response) => {
      const user = identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      response.json({
        user,
        durability: dependencies.snapshots.status(),
        configuration: {
          checkpointIntervalMs: dependencies.checkpointIntervalMs,
        },
      });
    }),
  );

  app.get(
    "/api/browser/catalog",
    asyncRoute(async (request, response) => {
      identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      response.json(await dependencies.browser.catalog());
    }),
  );

  app.get(
    "/api/browser/rows",
    asyncRoute(async (request, response) => {
      identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      const parsed = browserRowsQuery.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid browser row request" });
        return;
      }
      response.json(await dependencies.browser.rows(parsed.data));
    }),
  );

  app.get(
    "/api/notes",
    asyncRoute(async (request, response) => {
      identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      response.json({ notes: await dependencies.database.listNotes() });
    }),
  );

  app.post(
    "/api/notes",
    asyncRoute(async (request, response) => {
      const user = identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      const parsed = noteInput.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          error: "Note must be between 1 and 500 characters",
        });
        return;
      }
      const note = await dependencies.mutations.run(() =>
        dependencies.database.addNote(parsed.data.body, user.displayName),
      );
      response.status(201).json({ note });
    }),
  );

  app.post(
    "/api/checkpoints",
    asyncRoute(async (request, response) => {
      identity(
        request,
        dependencies.environment,
        dependencies.allowLocalIdentity,
      );
      const manifest = await dependencies.mutations.run(() =>
        dependencies.snapshots.checkpoint(),
      );
      response.status(201).json({
        manifest,
        durability: dependencies.snapshots.status(),
      });
    }),
  );

  registerTrustedSqlRoute(app, {
    environment: dependencies.environment,
    allowLocalIdentity: dependencies.allowLocalIdentity,
    database: dependencies.database,
    mutations: dependencies.mutations,
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof IdentityRequiredError) {
        response.status(401).json({ error: error.message });
        return;
      }
      if (error instanceof BrowserTableNotFoundError) {
        response.status(404).json({ error: "Table not found" });
        return;
      }
      if (error instanceof MutationsQuiescingError) {
        response.status(503).json({ error: error.message });
        return;
      }
      if (httpErrorType(error) === "entity.parse.failed") {
        response.status(400).json({ error: "Malformed JSON request body" });
        return;
      }
      if (httpErrorType(error) === "entity.too.large") {
        response.status(413).json({ error: "Request body is too large" });
        return;
      }
      console.error("Request failed", error);
      const message =
        dependencies.environment === "production"
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : "Unknown error";
      response.status(500).json({ error: message });
    },
  );

  if (!dependencies.webUiEnabled) {
    app.get("*", (_request, response) => {
      response.status(404).json({ error: "Web UI is disabled" });
    });
  }
}

function httpErrorType(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("type" in error)) return undefined;
  return typeof error.type === "string" ? error.type : undefined;
}

function identity(
  request: Request,
  environment: string,
  allowLocalIdentity = false,
) {
  return requestIdentity(request.headers, environment, allowLocalIdentity);
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}
