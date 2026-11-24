import type { Outcome, Route, Vehicle } from './DispatchRound';

interface Bay {
    vehicle: Vehicle;
    seatsLeft: number;
    reserved: number;
    stage: 'entering' | 'parked' | 'leaving';
}

export const levelOneSeats = 40;
export const levelOneBayCount = 4;

export class LevelOneDispatch {
    readonly ready: Set<string>;
    readonly bays: (Bay | null)[] = Array.from({ length: levelOneBayCount }, () => null);
    readonly queue: Route[] = [
        ...this.groups('teal', 60), ...this.groups('amber', 40), ...this.groups('red', 40),
        ...this.groups('teal', 20), ...this.groups('amber', 40), ...this.groups('red', 40),
    ];
    readonly totalPassengers = this.queue.length;
    boarded = 0;
    consumed = 0;

    constructor(vehicles: readonly Vehicle[]) {
        this.ready = new Set(vehicles.map(({ id }) => id));
    }

    get outcome(): Outcome {
        if (this.consumed === this.queue.length && this.bays.every((bay) => bay === null)) return 'won';
        if (this.boarded === this.consumed && this.bays.every((bay) => bay?.stage === 'parked') && this.boardingSlot() < 0) return 'lost';
        return 'playing';
    }

    dispatch(vehicle: Vehicle): number {
        const slot = this.bays.indexOf(null);
        if (slot < 0 || this.outcome !== 'playing' || !this.ready.delete(vehicle.id)) return -1;
        this.bays[slot] = { vehicle, seatsLeft: levelOneSeats, reserved: 0, stage: 'entering' };
        return slot;
    }

    park(slot: number): void {
        this.bays[slot]!.stage = 'parked';
    }

    boardingSlot(): number {
        const route = this.queue[this.consumed];
        return this.bays.findIndex((bay) => bay?.stage === 'parked' && bay.vehicle.route === route && bay.seatsLeft > bay.reserved);
    }

    reserve(slot: number): number {
        this.bays[slot]!.reserved++;
        return this.consumed++;
    }

    board(slot: number): number {
        const bay = this.bays[slot]!;
        bay.reserved--;
        this.boarded++;
        bay.seatsLeft--;
        if (!bay.seatsLeft) bay.stage = 'leaving';
        return bay.seatsLeft;
    }

    depart(slot: number): void {
        this.bays[slot] = null;
    }

    private groups(route: Route, passengers: number): Route[] {
        return Array<Route>(passengers).fill(route);
    }
}
