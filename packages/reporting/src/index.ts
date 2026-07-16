export { default as ReportingService } from './reporting_service.js'
export { assertNotInTenantScope } from './guard.js'
export { default as ReportingDashboardController } from './controllers/reporting_dashboard_controller.js'
export type { ReportingControllerOptions } from './controllers/reporting_dashboard_controller.js'
export { multitenancyReportingRoutes } from './routes.js'
export type {
  MultitenancyReportingRoutesOptions,
  ReportingRoutesOptions,
  ReportingRouteMiddleware,
} from './routes.js'
export { default as ReportExtensionRegistry } from './report_extension_registry.js'
export type { ReportExtension, ReportExtensionFilters } from './contracts/report_extension.js'
export { REPORTING_CONTRACT_VERSION } from './constants.js'
export { defineReportingConfig } from './validate_config.js'
export type {
  ReportingConfig,
  ReportingMetricDefinition,
  MultitenancyConfigWithReporting,
} from './validate_config.js'
export { formatReport, isReportFormat, REPORT_FORMATS } from './format.js'
export type { ReportFormat, ReportPayload } from './format.js'
export { getReportingOpenAPISpec, listReportingSpecPaths } from './openapi.js'
export type { CustomAggregation } from './custom_aggregate.js'
export type {
  ReportPeriod,
  AggregationOptions,
  ReportAggregate,
  TopTenantMetric,
  TenantUsage,
  CustomMetricBreakdown,
} from './types.js'
