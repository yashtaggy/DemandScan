/**
 * Shared defaults for zone filtering, imported by both the browser hooks/UI
 * and the server-side query parser so the two never drift.
 */

/** Formation Score (zones.score) floor applied when no minScore is supplied. */
export const DEFAULT_MIN_FORMATION_SCORE = 50;

// Formation Score is always populated; composite_score/score_components are
// currently NULL for every persisted zone, so sorting on them is meaningless.
export const DEFAULT_ZONE_SORT = 'score';
export const DEFAULT_ZONE_DIR: 'asc' | 'desc' = 'desc';
