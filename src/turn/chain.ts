/** The chain tool's engine: step-result reference substitution. */

export const CHAIN_MAX_STEPS = 6;

/** What every capped record (an inbox body, an interaction row) ends with — the app strips exactly
 *  this before pretty-printing. A tool result is never capped. */
export const TRUNCATION_MARKER = "\n…[truncated]";

/** `${2.items[0].id}` → ["2", "items", "0", "id"] — only digits, names, dots and [i]. */
const CHAIN_REF = /^\$\{(\d+)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*)\}$/;
const CHAIN_REF_EMBEDDED = new RegExp(CHAIN_REF.source.slice(1, -1), "g");

function pick(root: unknown, path: string): unknown {
    let cur = root;
    for (const hop of path.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)) {
        if (cur === null || typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[hop[1] ?? hop[2] ?? ""];
    }
    return cur;
}

export function substitute(args: unknown, data: unknown[], stepNo: number): unknown {
    if (typeof args === "string") {
        const whole = CHAIN_REF.exec(args);
        if (whole) {
            const from = Number(whole[1]);
            if (from >= stepNo) {
                throw new Error(
                    `step ${stepNo} refers to step ${from}, which has not run yet`,
                );
            }
            const value = pick(data[from], whole[2] ?? "");
            if (value === undefined) {
                throw new Error(
                    `step ${stepNo}: "${args}" found nothing in step ${from}'s ` +
                        `data — that tool may not expose a data channel, or the path is wrong`,
                );
            }
            return value;
        }
        return args.replace(CHAIN_REF_EMBEDDED, (_m, n, p) => {
            const value = pick(data[Number(n)], String(p));
            if (value === undefined) {
                throw new Error(`step ${stepNo}: unresolved \${${n}${p}}`);
            }
            return String(value);
        });
    }
    if (Array.isArray(args)) return args.map((a) => substitute(a, data, stepNo));
    if (args !== null && typeof args === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) out[k] = substitute(v, data, stepNo);
        return out;
    }
    return args;
}
