/**
 * The package's public surface.
 *
 * It had none until the dashboard needed to run an import: the migration was a
 * CLI, and `cli.ts` reached straight into the modules. Everything re-exported
 * here is what a caller other than the CLI needs, and nothing more — the
 * transforms stay private so that a second caller cannot start mapping legacy
 * values its own way.
 */

export {
  captureReport,
  configFrom,
  connectMysql,
  connectPostgres,
  d1Table,
  fmt,
  loadConfig,
  report,
  type Config,
  type ReportLine,
} from './db.js';
export { loadDump, type LoadedDump } from './load.js';
export {
  migrate,
  DOMAINS,
  PANEL_DEFAULT_DOMAINS,
  type Domain,
  type MigrateOptions,
  type MigrateResult,
  type StepResult,
} from './migrate.js';
export { preflight, summarise, type Finding } from './preflight.js';
export { verify, type Check } from './verify.js';
