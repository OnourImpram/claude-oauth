import { RouterError } from "../domain/errors.js";

export interface AntigravityTaskArguments {
    readonly model: string;
    /** The caller's process budget for this one call. Absent: the bridge default applies. */
    readonly timeoutMs?: number;
    /** What is left for the task parser: --task, --cwd and free task text. */
    readonly taskArguments: readonly string[];
}

// Whole seconds, no sign, no unit. The bound itself is the bridge's (one place decides it);
// this only refuses what is not a number of seconds, so a typo is an error and not a default.
const wholeSeconds = /^[1-9][0-9]{0,8}$/u;

/**
 * Arguments of the one-shot Antigravity commands. `--model` and `--timeout <seconds>` are
 * read here; everything else is handed on untouched. The values of `--task` and `--cwd` are
 * skipped, not inspected, so a task whose whole text is a flag name stays a task.
 */
export function parseAntigravityTaskArguments(args: readonly string[], fixedModel?: string): AntigravityTaskArguments {
    let model = fixedModel;
    let timeoutMs: number | undefined;
    const taskArguments: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--model") {
            const value = args[index + 1];
            if (value === undefined)
                throw new RouterError("invalid_request", "--model requires an exact model ID.", 400);
            if (fixedModel !== undefined && value !== fixedModel) {
                throw new RouterError("invalid_request", "The command has a fixed Antigravity model.", 400);
            }
            model = value;
            index += 1;
        }
        else if (argument === "--timeout") {
            const value = args[index + 1];
            if (value === undefined || !wholeSeconds.test(value)) {
                throw new RouterError("invalid_request", "--timeout requires whole seconds, for example --timeout 1800.", 400);
            }
            timeoutMs = Number(value) * 1_000;
            index += 1;
        }
        else if (argument === "--task" || argument === "--cwd") {
            taskArguments.push(argument);
            const value = args[index + 1];
            if (value !== undefined) {
                taskArguments.push(value);
                index += 1;
            }
        }
        else {
            taskArguments.push(argument ?? "");
        }
    }
    if (model === undefined) {
        throw new RouterError("invalid_request", "Antigravity requires --model.", 400);
    }
    return { model, taskArguments, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}
