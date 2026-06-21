---
"@adonisjs-lasagna/saas-tenancy": patch
---

Add an optional `fiscal` block to `BillingConfig` (`{ enabled?, automaticTax? }`). `BillingConfig` lives in core (core inlines the billing config shape so it can stay decoupled from the billing satellite), so the type for the billing satellite's opt-in fiscal features has to be declared here. Additive and optional — no behaviour change for existing configs.
