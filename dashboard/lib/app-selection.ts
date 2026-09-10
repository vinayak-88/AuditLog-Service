export type OwnerAppSummary = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { auditLogs: number };
};

/**
 * Resolves the explicitly selected app from an owner's app list.
 *
 * The requested ID is honoured only when it belongs to the authenticated
 * owner (it always does here — callers pass IDs taken from this same list).
 * Otherwise the first app is used so pages have a deterministic context.
 * Returns null when the owner has no apps.
 */
export function resolveSelectedAppId(
  apps: OwnerAppSummary[],
  requestedAppId: string | undefined
): string | null {
  if (apps.length === 0) return null;
  if (requestedAppId && apps.some((app) => app.id === requestedAppId)) {
    return requestedAppId;
  }
  return apps[0].id;
}
