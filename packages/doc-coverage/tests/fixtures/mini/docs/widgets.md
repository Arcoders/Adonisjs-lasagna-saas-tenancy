---
title: Widgets
code:
  - "@mini/widgets/services#WidgetService"
---

# Widgets

The `WidgetService` assembles widgets. Call `build` with a name and a size to
produce one. This page explains how widget assembly works end to end so the
service counts as explained, not merely exemplified.

```ts
import { WidgetService } from '@mini/widgets/services'

const widgets = new WidgetService()
widgets.build('a', 1)
```

Do not call `WidgetService.frobnicate()`; there is no such method (this line is a
deliberate dead-member case for the gate).
