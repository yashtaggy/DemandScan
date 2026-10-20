/**
 * Shared SQL statement splitter used by db/migrate.js (and asserted by
 * __tests__/scanner/schema.test.ts).
 *
 * Bug history: the old inline splitter in migrate.js split the file on ';'
 * FIRST and only then dropped lines starting with '--'. That broke on
 * semicolons inside comments (e.g. the v1 migration's
 * "(4 full 60-min candles; is_complete = TRUE)") and on trailing comments
 * after a ';' — both produced garbage statements that crashed the runner
 * mid-file, leaving every database only partially migrated.
 *
 * Correct order: strip comments first, then split on ';'.
 * Limitation: a '--' inside a string literal would be truncated. None of the
 * repo migrations contain one — keep it that way (the test suite guards the
 * contract, not this parser).
 */
function splitStatements(sqlText) {
  return sqlText
    .split('\n')
    // Remove full-line AND trailing comments before any ';' splitting.
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

module.exports = { splitStatements };
