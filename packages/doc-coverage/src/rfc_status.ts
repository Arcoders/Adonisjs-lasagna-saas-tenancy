/**
 * The machine-checked RFC status registry (RFC §11). Each entry pairs a stable
 * key with a substring that identifies its line in the RFC's implementation
 * checklist, plus whether it is actually implemented. `tests/rfc_status.test.ts`
 * parses the RFC and asserts every checkbox matches `implemented` here, so the
 * RFC can never promise what the tool does not ship (or vice-versa).
 */
export interface RfcStatusItem {
  key: string
  /** A substring that uniquely identifies this item's line in the RFC checklist. */
  matcher: string
  implemented: boolean
}

export const RFC_STATUS: RfcStatusItem[] = [
  { key: 'D1', matcher: 'D1, type-checked fences', implemented: true },
  { key: 'D2-hard', matcher: 'D2-hard, dead', implemented: true },
  { key: 'D2-soft', matcher: 'D2-soft, token-set diff', implemented: true },
  { key: 'D3', matcher: 'D3, path-normalized contract-hash freshness', implemented: true },
  { key: 'D4', matcher: 'D4, depth-bounded static reachability', implemented: true },
  { key: 'coverage', matcher: 'Coverage metric, explained', implemented: true },
  { key: 'api-extractor', matcher: 'api-extractor `.api.md` golden-diff', implemented: true },
  { key: 'baseline', matcher: 'Baseline plus per-check severity', implemented: true },
  { key: 'cli', matcher: '`docs:doctor` CLI plus a non-blocking CI', implemented: true },
  {
    key: 'determinism',
    matcher: 'Path-normalized contract hash plus deterministic-output',
    implemented: true,
  },
  { key: 'golden', matcher: 'Golden-fixture regression suite', implemented: true },
]

export interface ChecklistLine {
  checked: boolean
  text: string
}

/**
 * Extract the `- [x]` / `- [ ]` lines from the RFC's "Implementation status"
 * section (heading `## 11.`). Returns them in order; stops at the next `## `.
 */
export function parseRfcChecklist(rfcText: string): ChecklistLine[] {
  const lines = rfcText.split('\n')
  const start = lines.findIndex((l) => /^##\s+11\./.test(l))
  if (start === -1) return []
  const out: ChecklistLine[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^##\s/.test(line)) break
    const m = line.match(/^- \[([ x])\]\s+(.*)$/)
    if (m) out.push({ checked: m[1] === 'x', text: m[2]! })
  }
  return out
}
