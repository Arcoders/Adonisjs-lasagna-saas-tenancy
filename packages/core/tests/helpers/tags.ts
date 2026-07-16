/**
 * Shared Japa tags used to slice the suite by a cross-cutting concern rather than
 * by guarantee. A tag is not a location: an AI-motivated spec still lives under
 * the guarantee it proves (security, behavior, resilience, …); the tag only lets
 * `npm run test -- --tags @ai` (and the integration/fault runners likewise) run
 * the AI slice across guarantees. Single-sourced here so the string can never
 * drift via a typo in an individual spec.
 */

/** Marks a kernel spec that exists because of the AI satellite's requirements. */
export const AI_TAG = '@ai'
