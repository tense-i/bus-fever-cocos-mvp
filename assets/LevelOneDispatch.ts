import type { Outcome, Route, Vehicle } from './DispatchRound';

interface Bay {
    vehicle: Vehicle;
    seatsLeft: number;
    reserved: number;
    waitingGroups: number[][];
    nextGroupAt: number;
    stage: 'entering' | 'parked' | 'leaving';
}

export const levelOneSeats = 40;
export const levelOneBayCount = 4;
export const passengerGroupSize = 4;

export class LevelOneDispatch {
    readonly ready: Set<string>;
    readonly bays: (Bay | null)[] = Array.from({ length: levelOneBayCount }, () => null);
    readonly queue: Route[] = [
        ...this.groups('teal', 40), ...this.groups('red', 40), ...this.groups('teal', 40),
        ...this.groups('amber', 40), ...this.groups('red', 40), ...this.groups('amber', 40),
    ];
    readonly totalPassengers = this.queue.length;
    boarded = 0;
    consumed = 0;
    private blocked = false;
    private readonly exiting = new Set<string>();

    constructor(vehicles: readonly Vehicle[]) {
        this.ready = new Set(vehicles.map(({ id }) => id));
    }

    get outcome(): Outcome {
        if (this.consumed === this.queue.length && this.exiting.size === 0 && this.bays.every((bay) => bay === null)) return 'won';
        if (this.blocked) return 'lost';
        return 'playing';
    }

    dispatch(vehicle: Vehicle): number {
        const slot = this.bays.indexOf(null);
        if (slot < 0 || this.outcome !== 'playing' || !this.ready.delete(vehicle.id)) return -1;
        this.bays[slot] = { vehicle, seatsLeft: levelOneSeats, reserved: 0, stage: 'entering', waitingGroups: [], nextGroupAt: 0 };
        return slot;
    }

    park(slot: number, atExit: Route[]): void {
        this.bays[slot]!.stage = 'parked';
        this.blocked = this.boarded === this.consumed && this.bays.every(bay => bay?.stage === 'parked')
            && atExit.length > 0 && atExit.every(route => this.boardingSlot(route) < 0);
    }

    boardingSlot(route: Route): number {
        return this.bays.findIndex((_, index) => this.canReserve(index, route));
    }

    canReserve(slot: number, route: Route): boolean {
        const bay = this.bays[slot];
        return bay?.stage === 'parked' && bay.vehicle.route === route && bay.seatsLeft - bay.reserved >= passengerGroupSize;
    }

    reserve(slot: number, members: number[]): void {
        const bay = this.bays[slot]!;
        bay.reserved += members.length;
        this.consumed += members.length;
        bay.waitingGroups.push(members);
    }

    board(slot: number): number {
        const bay = this.bays[slot]!;
        bay.reserved--;
        this.boarded++;
        bay.seatsLeft--;
        if (!bay.seatsLeft) bay.stage = 'leaving';
        return bay.seatsLeft;
    }

    vacate(slot: number): void {
        this.exiting.add(this.bays[slot]!.vehicle.id);
        this.bays[slot] = null;
    }

    depart(vehicleId: string): void {
        this.exiting.delete(vehicleId);
    }

    private groups(route: Route, passengers: number): Route[] {
        return Array<Route>(passengers).fill(route);
    }
}
