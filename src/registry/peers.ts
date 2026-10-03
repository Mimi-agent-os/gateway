/** Who an agent may see: derived LIVE from P8 pins, never from a static manifest list. */

import type { PinCard } from "./admission.ts";

export interface PinLister {
    list(): PinCard[];
}

/** Every OTHER agent pin that is approved and standing discoverable; connection status is not
 *  part of it. */
export function peersOf(pins: PinLister, caller: string): string[] {
    return pins
        .list()
        .filter((p) => p.name !== caller && p.status === "approved" && p.perms.discoverable)
        .map((p) => p.name);
}
