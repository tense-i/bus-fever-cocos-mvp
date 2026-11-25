import type { Outcome } from './DispatchRound';
import { BusLevel, BusRoute, StagedVehicle, vehicleSeats } from './BusLevels';

interface BoardingGroup {
    members: number[];
    waitForEarlier: boolean;
    nextPassengerAt: number;
}

interface Bay {
    vehicle: StagedVehicle;
    seatsLeft: number;
    reserved: number;
    waitingGroups: BoardingGroup[];
    stage: 'entering' | 'parked' | 'leaving';
}

export const levelOneSeats = 40;
export const levelOneBayCount = 4;
export const passengerGroupSize = 4;

export class LevelOneDispatch {
    readonly ready: Set<string>;
    readonly bays: (Bay | null)[] = Array.from({ length: levelOneBayCount }, () => null);
    readonly queue: BusRoute[];
    readonly totalPassengers: number;
    boarded = 0;
    consumed = 0;
    private blocked = false;
    private readonly exiting = new Set<string>();

    constructor(level: BusLevel) {
        const waves = level.secondWaves ? [...level.waves, ...level.secondWaves] : level.waves;
        this.queue = waves.flatMap(([route, count]) => Array<BusRoute>(count).fill(route));
        this.totalPassengers = this.queue.length;
        this.ready = new Set(level.fleet.map(({ id }) => id));
    }

    get outcome(): Outcome {
        if (this.consumed === this.queue.length && this.exiting.size === 0 && this.bays.every((bay) => bay === null)) return 'won';
        if (this.blocked) return 'lost';
        return 'playing';
    }

    dispatch(vehicle: StagedVehicle): number {
        const slot = this.bays.indexOf(null);
        if (slot < 0 || this.outcome !== 'playing' || !this.ready.delete(vehicle.id)) return -1;
        this.bays[slot] = { vehicle, seatsLeft: vehicleSeats(vehicle), reserved: 0, stage: 'entering', waitingGroups: [] };
        return slot;
    }

    park(slot: number): void {
        this.bays[slot]!.stage = 'parked';
    }

    get needsFailureCheck(): boolean {
        return this.boarded === this.consumed && this.bays.every(bay => bay?.stage === 'parked');
    }

    checkFailure(cells: readonly number[]): void {
        this.blocked = cells.some(rider => rider >= 0)
            && !cells.some(rider => rider >= 0 && this.boardingSlot(this.queue[rider]) >= 0);
    }

    boardingSlot(route: BusRoute): number {
        return this.bays.findIndex((_, index) => this.canReserve(index, route));
    }

    canReserve(slot: number, route: BusRoute): boolean {
        const bay = this.bays[slot];
        return bay?.stage === 'parked' && bay.vehicle.route === route && bay.seatsLeft - bay.reserved >= passengerGroupSize;
    }

    reserve(slot: number, members: number[], waitForEarlier: boolean): void {
        const bay = this.bays[slot]!;
        bay.reserved += members.length;
        this.consumed += members.length;
        bay.waitingGroups.push({ members, waitForEarlier, nextPassengerAt: 0 });
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

}
