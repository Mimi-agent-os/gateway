/** Agent-pin admission: standing rights derived from the pins table. Identity itself is decided
 *  by the channel core's Noise IK handshake and its lookup callback (see registry/devices.ts) —
 *  this module only reads and writes the row that handshake already matched. */

import { noPerms } from "@mimi-os/protocol";
import type { PinPerms, PinStatus } from "@mimi-os/protocol";

import type { GatewayDb, PinRow } from "../store/db.ts";

export type PinCard = Omit<PinRow, "pubkey">;

const pinCard = ({ pubkey: _pubkey, ...card }: PinRow): PinCard => card;

export class Admissions {
    private readonly db: GatewayDb;

    constructor(db: GatewayDb) {
        this.db = db;
    }

    /** null = no pin for that name. */
    status(name: string): PinStatus | null {
        return this.db.getPin(name)?.status ?? null;
    }

    list(): PinCard[] {
        return this.db.listPins().map(pinCard);
    }

    get(name: string): PinCard | null {
        const row = this.db.getPin(name);
        return row ? pinCard(row) : null;
    }

    /** Back in the way an invite admits a key: approved, granted nothing until the owner does. */
    approve(name: string): PinCard | null {
        if (!this.db.setPinStatus(name, "approved", noPerms())) return null;
        return this.get(name);
    }

    block(name: string): PinCard | null {
        if (!this.db.setPinStatus(name, "blocked", noPerms())) return null;
        return this.get(name);
    }

    setPerms(name: string, perms: PinPerms): PinCard | null {
        if (!this.db.setPinPerms(name, perms)) return null;
        return this.get(name);
    }

    revoke(name: string): boolean {
        return this.db.deletePin(name);
    }

    seen(name: string, from: string | null): void {
        this.db.touchPin(name, from);
    }
}
