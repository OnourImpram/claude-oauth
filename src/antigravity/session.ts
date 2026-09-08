// G01 / Path D -- the Google lane, seen by the session registry.
//
// The registry needs an agent that RUNS ITS OWN TOOL LOOP inside one prompt call and
// blocks in the tool bridge while a call is parked. agy already does exactly that: it
// speaks MCP to whatever server its configuration names, and Path D names ours.
//
// So this file is thin on purpose. Everything that makes the lane safe -- the call-scoped
// configuration home, the nonce that never reaches a durable file -- lives in
// config-home.ts and headless-bridge.ts; here we only give the registry the handle shape
// it expects.
//
// KNOWN LIMIT, STATED RATHER THAN HIDDEN: `text()` is empty until the run finishes. The
// headless bridge buffers agy's stream-json and parses the terminal record, so prose the
// model emits BEFORE a tool call is not visible at the moment the call is parked. That
// costs streaming, not correctness: the tool call itself is delivered immediately and the
// full text arrives with the closing turn. Making it incremental means teaching the
// bridge's parser to emit partials, which is a separate change with its own measure.

import { RouterError } from "../domain/errors.js";
import type { AgentRunHandle } from "../mcp/session-registry.js";
import { runAntigravityHeadless } from "./headless-bridge.js";
import type { AgentToolEndpoint } from "./config-home.js";

export interface AntigravitySessionOptions {
    readonly binary: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: string;
    readonly home?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly toolEndpoint: AgentToolEndpoint;
    readonly configHomeRoot: string;
    readonly timeoutMs?: number;
}

export function startAntigravitySession(options: AntigravitySessionOptions): AgentRunHandle {
    const controller = new AbortController();
    let response = "";
    // cancel() can arrive before the run begins. Aborting a controller nobody is listening
    // to yet is not enough on its own -- the run reads the flag before it spawns, so a
    // cancellation in that window ends the session instead of leaving a child behind.
    let cancelled: string | undefined;

    const done = (async (): Promise<void> => {
        if (cancelled !== undefined)
            throw new RouterError("upstream_timeout", `Antigravity session was cancelled before start: ${cancelled}`, 504);
        const result = await runAntigravityHeadless({
            binary: options.binary,
            cwd: options.cwd,
            prompt: options.prompt,
            model: options.model,
            toolEndpoint: options.toolEndpoint,
            configHomeRoot: options.configHomeRoot,
            signal: controller.signal,
            ...(options.home === undefined ? {} : { home: options.home }),
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        response = result.response;
    })();

    return {
        done,
        text: () => response,
        cancel: (reason: string) => {
            cancelled ??= reason;
            controller.abort();
        },
    };
}
