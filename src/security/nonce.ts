import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
export const SESSION_HEADER = "x-hezarfen-oauth-session";
export function createSessionNonce(): string {
    return randomBytes(32).toString("base64url");
}
function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}
export function nonceMatches(expected: string, supplied: string | undefined): boolean {
    if (supplied === undefined)
        return false;
    return timingSafeEqual(digest(expected), digest(supplied));
}
