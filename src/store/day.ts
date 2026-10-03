/** The owner's day: every usage bucket, model limit and "today" is a calendar day in MIMI_TZ. */

const DAY_MS = 86_400_000;

// a POSIX TZ string (TZ=EEST-3) resolves to no IANA name at all: UTC is then the one honest default
const hostZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

let zone = hostZone();
let parts = formatterFor(zone);

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/** Boot sets MIMI_TZ here; unset keeps the host's zone. Throws on a name that is not an IANA zone. */
export function setTimeZone(name: string | undefined): string {
    const wanted = name?.trim() || hostZone();
    let formatter: Intl.DateTimeFormat;
    try {
        formatter = formatterFor(wanted);
    } catch {
        throw new Error(
            `MIMI_TZ="${wanted}" is not an IANA time zone: set it to a name like America/New_York, ` +
                `or remove it to use the host's zone`,
        );
    }
    // the owner's spelling, not ICU's canonical one (Asia/Kolkata, which ICU still calls Asia/Calcutta)
    zone = wanted;
    parts = formatter;
    return zone;
}

export const timeZone = (): string => zone;

/** The wall clock in the owner's zone at `at`, as UTC milliseconds of that same wall time. */
function wallMs(at: number): number {
    const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]), Number(p["minute"]), Number(p["second"]));
}

/** YYYY-MM-DD of `at` in the owner's zone. */
export const localDay = (at: number = Date.now()): string => new Date(wallMs(at)).toISOString().slice(0, 10);

/** Calendar arithmetic, never 24 h steps: a DST day is 23 or 25 hours long. */
export const shiftDay = (day: string, delta: number): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);

/** The UTC instant the owner's `day` begins (its local midnight). */
export function dayStart(day: string): number {
    const midnight = Date.parse(`${day}T00:00:00Z`);
    let at = midnight;
    // twice: the first guess may sit on the other side of a DST switch
    for (let i = 0; i < 2; i++) at = midnight - (wallMs(at) - at);
    return at;
}

/** What every "today" view names: the day, its zone, and the UTC instant the next day starts. */
export function dayInfo(at: number = Date.now()): { today: string; timeZone: string; resetsAt: string } {
    const today = localDay(at);
    return { today, timeZone: zone, resetsAt: new Date(dayStart(shiftDay(today, 1))).toISOString() };
}
