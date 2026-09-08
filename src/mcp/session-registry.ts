// Phase 9 / Path 4 -- the registry that keeps ACP sessions alive across Claude
// Code's successive requests.
//
// THE PROBLEM THIS SOLVES
// Anthropic's Messages API is stateless: every turn arrives with the whole
// history and nothing identifies "the conversation". An ACP session is
// stateful: the agent walks its own tool loop inside ONE prompt call and that
// call does not return until the agent is done. Today agent-model.ts compiles
// the history into one string and spawns a FRESH agent per request, so a tool
// loop can never survive a turn boundary.
//
// WHAT IDENTIFIES A SESSION
// Not a hash of the conversation -- Claude Code compacts history, and a hash
// would silently lose the session exactly when the conversation got long. The
// identifier is the tool call id: WE mint it (tool-bridge.ts), Claude Code
// echoes it back verbatim as tool_result.tool_use_id. So a request carrying
// tool_result blocks names its own session, and a tool_use id that belongs to
// no live session is BY DEFINITION an unmatched result -- the spec §7.3 gate
// falls out of the addressing scheme instead of being bolted on.
//
// EVERY WAY THIS BREAKS IS AN EXPLICIT STATE
// unknown call id (counted), swept session (named error, not a hang), agent
// exiting while a call is parked (parked calls cancelled), a second turn
// entering a session that is already running (refused), idle session (swept).

import { randomUUID } from "node:crypto";

import { RouterError } from "../domain/errors.js";
import { McpToolBridge, type McpToolDescriptor, type ParkedToolCall } from "./tool-bridge.js";

/** A running provider agent, seen from the registry's side. */
export interface AgentRunHandle {
    /** Settles when the agent's prompt call finishes on its own. */
    readonly done: Promise<void>;
    /** Everything the agent has said since it started. */
    text(): string;
    /** Stops the agent and its transport. */
    cancel(reason: string): void;
}

export interface StartAgentOptions {
    readonly prompt: string;
    readonly bridge: McpToolBridge;
    /** URL the agent must be told to reach the MCP tool server on. */
    readonly mcpUrl: string;
    /** Headers the agent must send with it -- the router session nonce. */
    readonly mcpHeaders: Readonly<Record<string, string>>;
    /** Upstream model name; the starter passes this on to the provider. */
    readonly model: string;
    readonly sessionKey: string;
}

export type AgentStarter = (options: StartAgentOptions) => AgentRunHandle;

/**
 * What one Claude Code request/response cycle resolved to.
 *
 * `tool_use` means the agent is BLOCKED inside the bridge waiting for a result;
 * the session stays alive. `end_turn` means the agent finished and the session
 * is retired.
 */
export type TurnOutcome =
    | { readonly kind: "tool_use"; readonly text: string; readonly call: ParkedToolCall }
    | { readonly kind: "end_turn"; readonly text: string };

/**
 * What ended a turn, WITHOUT its text.
 *
 * Text is deliberately not carried here. It is sliced when the turn is
 * CONSUMED, not when the event is produced: an agent can call a tool inside
 * startAgent, before the run handle exists, and slicing then would attribute an
 * empty string to this turn and replay the same text on the next one.
 */
type TurnEvent =
    | { readonly kind: "tool_use"; readonly call: ParkedToolCall }
    | { readonly kind: "end_turn" };

export interface SessionRegistryOptions {
    /** How long a session may sit without a turn before it is swept. */
    readonly idleTimeoutMs?: number;
    /** Injected so tests do not depend on wall-clock time. */
    readonly now?: () => number;
    /**
     * Base URL of the router loopback server, e.g. http://127.0.0.1:8787
     *
     * A function is allowed because the router does not exist yet when this
     * registry is built: the provider set is started BEFORE the listener. A
     * lazy read keeps the two from having to be born in the wrong order.
     */
    readonly mcpBaseUrl: string | (() => string);
    /** Read lazily for the same reason; the session nonce is minted later. */
    readonly mcpHeaders?: () => Readonly<Record<string, string>>;
    /**
     * Time of death for a parked call. DEFAULT: none (0).
     *
     * The bridge's own 600 s default was SHORT relative to a human-speed permission
     * prompt or a long-running tool; worse, the timeout wrote Claude Code's
     * late-arriving tool_result into the unmatched counter. Authority now lies with
     * the router's request timeout and the sweep: two different events are written to
     * two different counters (see timedOutResultCount).
     */
    readonly callTimeoutMs?: number;
    /** Ceiling on concurrent live sessions. Each session means one provider process. */
    readonly maxLiveSessions?: number;
    readonly startAgent: AgentStarter;
}

const defaultIdleTimeoutMs = 30 * 60 * 1000;

class AgentSession {
    readonly key: string;
    readonly bridge: McpToolBridge;
    #handle: AgentRunHandle | undefined;
    #textCursor = 0;
    #resolveTurn: ((event: TurnEvent) => void) | undefined;
    #rejectTurn: ((error: unknown) => void) | undefined;
    // An agent may call a tool synchronously, BEFORE the turn that will read the
    // outcome has been armed. Without this buffer that outcome is dropped and the
    // request hangs forever. Same defect class the bridge closes by parking
    // before it notifies: a synchronous producer racing an unarmed consumer.
    #queued: TurnEvent[] = [];
    /** An agent that died before any turn was armed. Reported, never swallowed. */
    #failure: unknown;
    #finished = false;
    #running = false;
    touchedAt: number;

    constructor(key: string, onToolCall: (call: ParkedToolCall) => void, now: number, callTimeoutMs: number) {
        this.key = key;
        this.touchedAt = now;
        this.bridge = new McpToolBridge({ onToolCall, callTimeoutMs });
    }

    get finished(): boolean {
        return this.#finished;
    }

    get running(): boolean {
        return this.#running;
    }

    attach(handle: AgentRunHandle): void {
        this.#handle = handle;
        // The agent finishing is one of the two ways a turn can end. It is wired
        // once, here, so a turn started later cannot miss an agent that already
        // exited -- #finished is checked on entry to every turn.
        void handle.done.then(
            () => this.#agentSettled(undefined),
            (error: unknown) => this.#agentSettled(error),
        );
    }

    /** Text the agent produced since the previous turn, never the whole log. */
    #sliceText(): string {
        const full = this.#handle?.text() ?? "";
        const slice = full.slice(this.#textCursor);
        this.#textCursor = full.length;
        return slice;
    }

    #agentSettled(error: unknown): void {
        this.#finished = true;
        // An agent that exits while a call is parked would leave Claude Code
        // waiting forever for a tool_use that will never be answered.
        this.bridge.cancelAll("agent session ended");
        const resolve = this.#resolveTurn;
        const reject = this.#rejectTurn;
        this.#resolveTurn = undefined;
        this.#rejectTurn = undefined;
        this.#running = false;
        if (error !== undefined) {
            if (reject === undefined) this.#failure = error;
            else reject(error);
            return;
        }
        // No buffering here on purpose. The mutation control showed this branch
        // was not load-bearing: an agent that settles with no turn armed is
        // already covered by the #finished check on the next awaitTurn, which
        // slices the same text. A branch no control can fail measures nothing.
        resolve?.({ kind: "end_turn" });
    }

    /**
     * Waits for whichever comes first: the agent calling a tool, or the agent
     * finishing. Called once per Claude Code request.
     */
    async awaitTurn(): Promise<TurnOutcome> {
        if (this.#running) {
            throw new RouterError(
                "invalid_request",
                "This agent session already has a turn in flight.",
                409,
            );
        }
        // Buffered outcomes are drained before anything else, including the
        // finished check: an agent that called a tool and then exited still owes
        // Claude Code that tool_use.
        const queued = this.#queued.shift();
        if (queued !== undefined) return this.#withText(queued);
        if (this.#failure !== undefined) {
            const failure = this.#failure;
            this.#failure = undefined;
            throw failure;
        }
        if (this.#finished) {
            return { kind: "end_turn", text: this.#sliceText() };
        }
        this.#running = true;
        const event = await new Promise<TurnEvent>((resolve, reject) => {
            this.#resolveTurn = resolve;
            this.#rejectTurn = reject;
        });
        return this.#withText(event);
    }

    /** Attaches the text produced since the previous turn to a turn event. */
    #withText(event: TurnEvent): TurnOutcome {
        const text = this.#sliceText();
        return event.kind === "tool_use"
            ? { kind: "tool_use", text, call: event.call }
            : { kind: "end_turn", text };
    }

    /** Called by the registry when the bridge parks a call for this session. */
    parkedToolCall(call: ParkedToolCall): void {
        const resolve = this.#resolveTurn;
        this.#resolveTurn = undefined;
        this.#rejectTurn = undefined;
        this.#running = false;
        const event: TurnEvent = { kind: "tool_use", call };
        if (resolve === undefined) this.#queued.push(event);
        else resolve(event);
    }

    cancel(reason: string): void {
        this.#finished = true;
        this.bridge.cancelAll(reason);
        this.#handle?.cancel(reason);
        const reject = this.#rejectTurn;
        this.#resolveTurn = undefined;
        this.#rejectTurn = undefined;
        this.#running = false;
        reject?.(new RouterError("upstream_timeout", `Agent session cancelled: ${reason}.`, 504));
    }
}

export interface BeginResult {
    readonly sessionKey: string;
    readonly outcome: TurnOutcome;
}

/** One Anthropic tool_result block, flattened to what the bridge needs. */
export interface ToolResultDelivery {
    readonly toolUseId: string;
    readonly content: string;
    readonly isError: boolean;
}

export class AgentSessionRegistry {
    #sessions = new Map<string, AgentSession>();
    /** tool call id -> session key. The addressing scheme, see header. */
    #calls = new Map<string, string>();
    #orphanResults = 0;
    readonly #idleTimeoutMs: number;
    readonly #now: () => number;
    readonly #mcpBaseUrl: string | (() => string);
    readonly #mcpHeaders: () => Readonly<Record<string, string>>;
    readonly #callTimeoutMs: number;
    readonly #maxLiveSessions: number;
    /** Calls the router itself dropped on its own timeout. Counted SEPARATELY. */
    #timedOutResults = 0;
    readonly #timedOutCalls = new Set<string>();
    readonly #startAgent: AgentStarter;

    constructor(options: SessionRegistryOptions) {
        this.#idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs;
        this.#now = options.now ?? Date.now;
        this.#mcpBaseUrl = options.mcpBaseUrl;
        this.#mcpHeaders = options.mcpHeaders ?? (() => ({}));
        this.#callTimeoutMs = options.callTimeoutMs ?? 0;
        this.#maxLiveSessions = options.maxLiveSessions ?? 4;
        this.#startAgent = options.startAgent;
    }

    get liveSessionCount(): number {
        return this.#sessions.size;
    }

    /**
     * spec §7.3 gate. Two ways a result can be unmatched and BOTH are counted:
     * an id no session ever minted (orphan), and an id whose session no longer
     * has it parked (the bridge's own counter). A gate that saw only one of
     * them would report zero while work was lost.
     */
    get unmatchedResultCount(): number {
        let total = this.#orphanResults;
        // Calls the router dropped on its own timeout are NOT written to THIS counter:
        // if 'work was lost' and 'we gave up' collapse into the same number, the gate
        // cannot say what it measures.
        for (const session of this.#sessions.values()) {
            total += session.bridge.unmatchedResultCount;
        }
        return total;
    }

    /**
     * Calls the router dropped on its own timeout and whose answer arrived afterwards.
     *
     * A counter that always returns zero is worse than a counter that does not exist:
     * it looks green and measures nothing. That is why it is SUMMED across the bridges
     * and a retired session's contribution is carried over.
     */
    get timedOutResultCount(): number {
        let total = this.#timedOutResults;
        for (const session of this.#sessions.values()) {
            total += session.bridge.timedOutResultCount;
        }
        return total;
    }

    /** The MCP endpoint the agent is told about for this session. */
    mcpUrlFor(sessionKey: string): string {
        const base = (typeof this.#mcpBaseUrl === "function" ? this.#mcpBaseUrl() : this.#mcpBaseUrl)
            .replace(/\/+$/u, "");
        // An empty base would hand the agent a relative URL it silently fails to
        // reach. Named error instead: the wiring ran in the wrong order.
        if (base === "") {
            throw new RouterError("adapter_unavailable", "The MCP base URL is not known yet. ONARIM: the session registry was used before the router server started; wire the router base URL before starting a provider set.", 503);
        }
        return `${base}/mcp/${sessionKey}`;
    }

    /** Looks up a live session by key, for the HTTP MCP route. */
    bridgeFor(sessionKey: string): McpToolBridge | undefined {
        const session = this.#sessions.get(sessionKey);
        if (session === undefined) return undefined;
        session.touchedAt = this.#now();
        return session.bridge;
    }

    /** Starts a new agent and runs its first turn. */
    async begin(
        prompt: string,
        tools: readonly McpToolDescriptor[],
        model = "",
        signal?: AbortSignal,
    ): Promise<BeginResult> {
        this.sweep();
        // Each live session means one provider PROCESS. Without a ceiling, concurrent
        // requests fill the machine; the adapter's own #queue serialisation does not
        // apply on this path (the tool path bypasses #invoke).
        // When a user opens a new conversation with a plain turn, the old session is left
        // UNADDRESSABLE: because its identity is the tool_use.id, nobody can reach it
        // again, yet its process lives on. On hitting the ceiling the oldest IDLE session
        // is reclaimed -- recovering the resource rather than hitting the user with a 503.
        while (this.#sessions.size >= this.#maxLiveSessions) {
            let enEski: [string, AgentSession] | undefined;
            for (const giris of this.#sessions) {
                if (giris[1].running) continue;
                if (enEski === undefined || giris[1].touchedAt < enEski[1].touchedAt) enEski = giris;
            }
            if (enEski === undefined) {
                // All of them are mid-turn: there is nothing to reclaim, and silently
                // opening one more fills the machine.
                throw new RouterError(
                    "adapter_unavailable",
                    `Too many agent turns in flight (${this.#sessions.size}). ONARIM: wait for a turn to finish or cancel one; each live session holds a provider process.`,
                    503,
                );
            }
            enEski[1].cancel("reclaimed: oldest idle session");
            this.#retire(enEski[0]);
        }
        const sessionKey = randomUUID().replace(/-/gu, "");
        const session = new AgentSession(
            sessionKey,
            (call) => {
                // Indexed BEFORE the turn resolves: the adapter answers Claude
                // Code the moment the turn resolves, and the tool_result can
                // come back before this line would otherwise have run.
                this.#calls.set(call.id, sessionKey);
                session.parkedToolCall(call);
            },
            this.#now(),
            this.#callTimeoutMs,
        );
        session.bridge.setTools(tools);
        this.#sessions.set(sessionKey, session);
        session.attach(
            this.#startAgent({
                prompt,
                bridge: session.bridge,
                mcpUrl: this.mcpUrlFor(sessionKey),
                mcpHeaders: this.#mcpHeaders(),
                model,
                sessionKey,
            }),
        );
        const outcome = await this.#settle(sessionKey, session, signal);
        return { sessionKey, outcome };
    }

    /**
     * Delivers the tool results of one Claude Code user turn and runs the next
     * agent turn.
     *
     * An Anthropic user turn carries EVERY tool_result together, so this takes a
     * list. The first id names the session; the rest must belong to the same one,
     * because a single Claude Code conversation talks to a single agent.
     *
     * An id nobody minted, or one whose session is gone, is an unmatched result
     * -- counted and reported, never swallowed (spec §7.3).
     */
    async resume(results: readonly ToolResultDelivery[], signal?: AbortSignal): Promise<BeginResult> {
        if (results.length === 0) {
            throw new RouterError("invalid_request", "A resumed turn must carry at least one tool result.", 400);
        }
        const first = results[0] as ToolResultDelivery;
        const sessionKey = this.#calls.get(first.toolUseId);
        const session = sessionKey === undefined ? undefined : this.#sessions.get(sessionKey);
        if (sessionKey === undefined || session === undefined) {
            this.#orphanResults += results.length;
            throw new RouterError(
                "invalid_request",
                "This tool result belongs to no live agent session. ONARIM: the session was swept or the router restarted; send the turn again without tool_result blocks so a fresh session starts.",
                409,
            );
        }
        session.touchedAt = this.#now();
        // The turn is armed BEFORE any result is delivered: delivering unblocks
        // the agent, which may park its next call immediately.
        const turn = session.awaitTurn();
        let delivered = 0;
        for (const result of results) {
            const owner = this.#calls.get(result.toolUseId);
            if (owner !== sessionKey) {
                // Belongs to another session, or to none. Counted, and the agent
                // is left waiting rather than fed someone else's answer.
                this.#orphanResults += 1;
                continue;
            }
            this.#calls.delete(result.toolUseId);
            if (session.bridge.deliverToolResult(result.toolUseId, result.content, result.isError)) {
                delivered += 1;
            }
        }
        if (delivered === 0) {
            // Nothing was released, so nothing will ever resolve this turn.
            // Failing loudly beats hanging until the request times out.
            session.cancel("no tool result matched a parked call");
            this.#retire(sessionKey);
            await turn.catch(() => undefined);
            throw new RouterError(
                "invalid_request",
                "No tool result matched a parked call in this session.",
                409,
            );
        }
        const outcome = await this.#awaitSettled(sessionKey, session, turn, signal);
        return { sessionKey, outcome };
    }

    async #settle(sessionKey: string, session: AgentSession, signal?: AbortSignal): Promise<TurnOutcome> {
        return await this.#awaitSettled(sessionKey, session, session.awaitTurn(), signal);
    }

    async #awaitSettled(
        sessionKey: string,
        session: AgentSession,
        turn: Promise<TurnOutcome>,
        signal?: AbortSignal,
    ): Promise<TurnOutcome> {
        // FINDING 1. Without this wiring the router's 300 s request timeout and the two
        // client-disconnect aborts stay DEAD ON THIS ROUTE: the only thing that would end
        // a running ACP turn is the agent finishing on its own. On top of that a #running
        // session is never swept, so a stuck session is immortal.
        const iptal = (): void => session.cancel("client request aborted");
        if (signal !== undefined) {
            if (signal.aborted) iptal();
            else signal.addEventListener("abort", iptal, { once: true });
        }
        try {
            const outcome = await turn;
            if (outcome.kind === "end_turn") this.#retire(sessionKey);
            else session.touchedAt = this.#now();
            return outcome;
        } catch (error) {
            this.#retire(sessionKey);
            throw error;
        } finally {
            signal?.removeEventListener("abort", iptal);
        }
    }

    #retire(sessionKey: string): void {
        const session = this.#sessions.get(sessionKey);
        if (session === undefined) return;
        // The orphan counter must survive the session it belonged to, otherwise
        // retiring a session would quietly erase evidence the gate exists for.
        this.#orphanResults += session.bridge.unmatchedResultCount;
        this.#timedOutResults += session.bridge.timedOutResultCount;
        this.#sessions.delete(sessionKey);
        for (const [callId, key] of this.#calls) {
            if (key === sessionKey) this.#calls.delete(callId);
        }
    }

    /** Removes sessions no turn has touched inside the idle window. */
    sweep(): number {
        const cutoff = this.#now() - this.#idleTimeoutMs;
        let swept = 0;
        for (const [key, session] of [...this.#sessions]) {
            if (session.running || session.touchedAt > cutoff) continue;
            session.cancel("idle session swept");
            this.#retire(key);
            swept += 1;
        }
        return swept;
    }

    /** Tears everything down. Used on router shutdown. */
    closeAll(reason: string): number {
        const count = this.#sessions.size;
        for (const [key, session] of [...this.#sessions]) {
            session.cancel(reason);
            this.#retire(key);
        }
        return count;
    }
}
