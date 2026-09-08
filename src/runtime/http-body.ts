import { RouterError } from "../domain/errors.js";
export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
        throw new RouterError("upstream_protocol_error", "The provider response exceeded the safe size limit.", 502);
    }
    if (response.body === null) {
        throw new RouterError("upstream_protocol_error", "The provider response body is missing.", 502);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            size += chunk.value.byteLength;
            if (size > maximumBytes) {
                await reader.cancel();
                throw new RouterError("upstream_protocol_error", "The provider response exceeded the safe size limit.", 502);
            }
            chunks.push(chunk.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8"));
    }
    catch (error) {
        if (error instanceof RouterError)
            throw error;
        throw new RouterError("upstream_protocol_error", "The provider response was not valid JSON.", 502, {
            cause: error,
        });
    }
}
