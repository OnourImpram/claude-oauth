// Live-probe budget for Antigravity catalog verification. Measured 2026-10-18 on the operator
// machine: Gemini 3.8 Flash 55 s, Gemini 4 Argon High 114-172 s for a one-line reply. A 60 s
// budget made every slow-but-healthy model fail verification and drop out of the snapshot.
// headless-bridge accepts whole seconds up to its process backstop; a probe is a one-line
// reply and stays far below it.
export const ANTIGRAVITY_PROBE_TIMEOUT_MS = 240_000;
// Outer abort: must outlive the child's own timeout so the child's error is the one reported.
export const ANTIGRAVITY_PROBE_ABORT_MS = ANTIGRAVITY_PROBE_TIMEOUT_MS + 5_000;
