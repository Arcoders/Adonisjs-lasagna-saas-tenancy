---
"@adonisjs-lasagna/admin": patch
---

Move the pure, container-free controller helpers into a dedicated
`controllers/pure.ts` module. The pagination clamp, the non-empty-string and
URL checks, the partial-update three-state pick, and the ISO date/expiry
parsers were duplicated and inlined across the controllers, where they could
not be exercised without booting the whole app (a controller import pulls in
the package barrel, which top-level-awaits `app.booted`). They now live in one
barrel-free module the controllers import from, locked by a unit suite. This is
an internal refactor with no change to the admin API or its behavior.
