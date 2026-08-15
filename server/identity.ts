export interface RequestIdentity {
  id: string;
  displayName: string;
}

export class IdentityRequiredError extends Error {
  constructor() {
    super("Databricks proxy identity is required");
    this.name = "IdentityRequiredError";
  }
}

export type IdentityHeaders = Record<
  string,
  string | string[] | undefined
>;

export function requestIdentity(
  headers: IdentityHeaders,
  environment: string,
  allowLocalIdentity = false,
): RequestIdentity {
  const userId = header(headers, "x-forwarded-user");
  const displayName =
    header(headers, "x-forwarded-preferred-username") ??
    header(headers, "x-forwarded-email") ??
    userId;
  if (userId && displayName) return { id: userId, displayName };
  if (environment === "development" || allowLocalIdentity) {
    return { id: "local-developer", displayName: "Local developer" };
  }
  throw new IdentityRequiredError();
}

function header(headers: IdentityHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
