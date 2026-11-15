import { appendFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
    OAUTH_TYPES,
    PROVIDER_IDS,
    REQUEST_CLASSES,
    ROUTER_ERROR_CODES,
    type ProviderId,
    type RequestClass,
    type RouteReceipt,
    type RouterErrorCode,
} from "../domain/contracts.js";
import { RouterError } from "../domain/errors.js";
import { numericUsage } from "../domain/validation.js";
import { ensurePrivateDirectory } from "./paths.js";
const maximumReceiptBytes = 2 * 1024 * 1024;
export class ReceiptStore {
    #tail: Promise<void> = Promise.resolve();
    constructor(private readonly path: string) {
    }
    async append(receipt: RouteReceipt): Promise<void> {
        const operation = this.#tail.then(async () => await this.#appendNow(receipt));
        this.#tail = operation.catch(() => undefined);
        return await operation;
    }
    async #appendNow(receipt: RouteReceipt): Promise<void> {
        await ensurePrivateDirectory(dirname(this.path));
        await this.#rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    async last(): Promise<RouteReceipt | undefined> {
        await this.#tail;
        let content: string;
        try {
            content = await readFile(this.path, "utf8");
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return undefined;
            throw error;
        }
        const line = content.trimEnd().split("\n").at(-1);
        if (line === undefined || line === "")
            return undefined;
        try {
            return parseReceipt(JSON.parse(line));
        }
        catch (error) {
            throw new RouterError("upstream_protocol_error", "The local receipt file is malformed.", 502, { cause: error });
        }
    }
    /**
     * Every readable receipt, oldest first: the rotated file, then the current one. A line that
     * does not parse as a receipt is counted and skipped -- one damaged line (a crash mid-write)
     * must not hide the rest of the history from a summary.
     */
    async all(): Promise<{ readonly receipts: readonly RouteReceipt[]; readonly malformedLines: number }> {
        await this.#tail;
        const receipts: RouteReceipt[] = [];
        let malformedLines = 0;
        for (const path of [`${this.path}.previous`, this.path]) {
            let content: string;
            try {
                content = await readFile(path, "utf8");
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                    continue;
                throw error;
            }
            for (const line of content.split("\n")) {
                if (line.trim() === "")
                    continue;
                try {
                    receipts.push(parseReceipt(JSON.parse(line)));
                }
                catch {
                    malformedLines += 1;
                }
            }
        }
        return { receipts, malformedLines };
    }
    async #rotateIfNeeded(): Promise<void> {
        try {
            const metadata = await stat(this.path);
            if (metadata.size < maximumReceiptBytes)
                return;
            const previous = `${this.path}.previous`;
            try {
                await unlink(previous);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            await rename(this.path, previous);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
    }
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value: unknown, maximum = 512): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function parseReceipt(value: unknown): RouteReceipt {
    if (!isRecord(value) || value["schemaVersion"] !== 1)
        throw new Error("invalid receipt header");
    const provider = value["provider"];
    const oauthType = value["oauthType"];
    const status = value["status"];
    const errorCode = value["errorCode"];
    const providerRequestId = value["providerRequestId"];
    const usage = numericUsage(value["usage"]);
    // A class this build does not know is dropped, not refused: a newer router (or a newer
    // Claude Code list) must not make older receipts unreadable, and vice versa.
    const requestClass = (REQUEST_CLASSES as readonly unknown[]).includes(value["requestClass"]) ? value["requestClass"] as RequestClass : undefined;
    if (!boundedString(value["timestamp"]) ||
        Number.isNaN(new Date(value["timestamp"]).valueOf()) ||
        !boundedString(value["requestId"], 128) ||
        !boundedString(value["requestedModel"], 256) ||
        !boundedString(value["configuredModel"], 256) ||
        !PROVIDER_IDS.includes(provider as ProviderId) ||
        !(OAUTH_TYPES as readonly string[]).includes(String(oauthType)) ||
        typeof value["durationMs"] !== "number" ||
        !Number.isFinite(value["durationMs"]) ||
        value["durationMs"] < 0 ||
        !["completed", "failed", "cancelled"].includes(String(status)) ||
        (errorCode !== undefined && !ROUTER_ERROR_CODES.includes(errorCode as RouterErrorCode)) ||
        (providerRequestId !== undefined && !boundedString(providerRequestId, 256)) ||
        (value["usage"] !== undefined && usage === undefined)) {
        throw new Error("invalid receipt body");
    }
    return {
        schemaVersion: 1,
        timestamp: value["timestamp"],
        requestId: value["requestId"],
        requestedModel: value["requestedModel"],
        configuredModel: value["configuredModel"],
        provider: provider as ProviderId,
        oauthType: oauthType as RouteReceipt["oauthType"],
        durationMs: value["durationMs"],
        status: status as RouteReceipt["status"],
        ...(errorCode === undefined
            ? {}
            : { errorCode: errorCode as RouterErrorCode }),
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        ...(usage === undefined ? {} : { usage }),
        ...(requestClass === undefined ? {} : { requestClass }),
    };
}
