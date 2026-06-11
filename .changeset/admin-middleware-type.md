---
'@adonisjs-lasagna/admin': patch
---

`AdminRouteMiddleware` now accepts named-middleware references produced by `router.named(...)` (the `middleware.adminAuth()` shape) in its type, matching what `multitenancyAdminRoutes` always accepted at runtime. Previously only strings and bare functions typechecked, forcing a cast.
