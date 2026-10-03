/** The device fanout: one in-memory hub every /api/events stream subscribes to. */

export interface HubEvent {
    type:
        | "inbox_item"
        | "inbox_changed"
        | "approval"
        | "approval_resolved"
        | "interaction"
        | "room_message"
        | "room_changed"
        | "chat_changed"
        | "device_enrolled"
        | "device_activated"
        | "device_revoked"
        | "agent_changed"
        | "agent_enrolled"
        | "usage_changed"
        | "limits_changed";
    [key: string]: unknown;
}

const MAX_SUBSCRIBERS = 64;

export class EventHub {
    private readonly subs = new Set<(ev: HubEvent) => void>();
    private readonly log: (msg: string) => void;

    constructor(log: (msg: string) => void = () => undefined) {
        this.log = log;
    }

    /** null = the hub is full; the caller answers 503 rather than pretend to be listening. */
    subscribe(fn: (ev: HubEvent) => void): (() => void) | null {
        if (this.subs.size >= MAX_SUBSCRIBERS) return null;
        this.subs.add(fn);
        return () => void this.subs.delete(fn);
    }

    /** A broken listener is dropped, never rethrown: fanout must not fail the thing that fanned. */
    emit(ev: HubEvent): void {
        for (const fn of [...this.subs]) {
            try {
                fn(ev);
            } catch (e) {
                this.subs.delete(fn);
                this.log(`[events] dropped a listener: ${(e as Error).message}\n`);
            }
        }
    }

    size(): number {
        return this.subs.size;
    }

    clear(): void {
        this.subs.clear();
    }
}
