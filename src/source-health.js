// A source may remain enabled for collection retries while its last successful
// snapshot is stale or superseded by an error. Such rows are historical
// evidence, not current scoring evidence.
export const SOURCE_FRESHNESS_HOURS = 2;

export function currentSourcePredicate(alias = 'active_source') {
  return `
    COALESCE(${alias}.enabled, 1) = 1
    AND ${alias}.last_success_at IS NOT NULL
    AND julianday(${alias}.last_success_at) >= julianday('now','-${SOURCE_FRESHNESS_HOURS} hours')
    AND (${alias}.last_error_at IS NULL OR ${alias}.last_success_at >= ${alias}.last_error_at)
  `;
}
