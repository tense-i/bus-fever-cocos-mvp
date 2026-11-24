import { log, Node, Vec3 } from 'cc';
import { passengerGroupSize } from './LevelOneDispatch';

type Position = [number, number, number];

export interface ConveyorPaths {
    exitPercent: number;
    capacity: number;
    exitStartPercent: number;
    exitEndPercent: number;
    spacing: number;
    ring: Position[];
    entry: Position[];
}

const entryTravelTime = 1.35;
const fillDuration = 4.65;
const normalSpeed = 0.123;
const boostedSpeed = 0.221;
const rowWidth = passengerGroupSize;
const laneSpacing = 0.13;

export class PassengerConveyor {
    private readonly ring: Vec3[];
    private readonly entry: Vec3[];
    private readonly merge: number;
    private readonly step: number;
    private readonly entrySpan: number;
    private readonly sample = new Vec3();
    private elapsed = 0;
    private speed = normalSpeed;
    private boosted = false;
    private front: number;
    private admitted = 0;
    private readonly cells: number[];
    private readonly reservedCells = new Map<number, number>();
    readonly exitCells: number[] = [];

    constructor(ground: Node, private readonly paths: ConveyorPaths, avatarCount: number) {
        const local = ([x, y, z]: Position) => ground.inverseTransformPoint(new Vec3(), new Vec3(-x, y, z));
        this.ring = paths.ring.map(local);
        const entry = paths.entry.map(local).reverse();
        const end = entry[entry.length - 1];
        let mergeIndex = 0;
        let distance = Infinity;
        this.ring.slice(0, -1).forEach((position, index) => {
            const candidate = Vec3.squaredDistance(position, end);
            if (candidate < distance) {
                distance = candidate;
                mergeIndex = index;
            }
        });
        this.entry = [...entry, this.ring[mergeIndex]];
        this.merge = mergeIndex / (this.ring.length - 1);
        const ringLength = this.length(this.ring);
        this.entrySpan = this.length(this.entry) / ringLength;
        this.cells = Array(Math.min(avatarCount, paths.capacity * rowWidth)).fill(-1);
        this.step = 1 / paths.capacity;
        this.front = -this.entrySpan;
    }

    reset(riders: readonly Node[]): void {
        this.elapsed = 0;
        this.boosted = false;
        this.speed = normalSpeed;
        this.front = -this.entrySpan;
        this.admitted = this.cells.length;
        this.reservedCells.clear();
        this.exitCells.length = 0;
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = i;
        riders.forEach((rider) => { rider.active = false; });
    }

    update(
        dt: number, riders: readonly Node[],
        setMoving: (index: number, moving: boolean) => void,
    ): boolean {
        this.elapsed = Math.min(fillDuration, this.elapsed + dt);
        const previous = this.front;
        const filling = this.elapsed < fillDuration;
        if (this.elapsed < entryTravelTime) this.front = this.entrySpan * (this.elapsed / entryTravelTime - 1);
        else if (filling) this.front = (this.elapsed - entryTravelTime) / (fillDuration - entryTravelTime);
        else {
            if (previous < 1) this.speed = 1 / (fillDuration - entryTravelTime);
            this.speed = this.boosted ? boostedSpeed : Math.max(normalSpeed, this.speed - 0.31 * dt);
            this.front = Math.max(1, previous + dt * this.speed);
        }
        this.exitCells.length = 0;
        for (let cell = 0; cell < this.cells.length; cell++) {
            const lag = this.step * Math.floor(cell / rowWidth);
            const distance = this.front - lag;
            if (this.cells[cell] < 0 && this.admitted < riders.length &&
                Math.floor(distance) > Math.floor(previous - lag)) {
                this.cells[cell] = this.admitted++;
                log(`[OwnedGameplay] belt-refill rider=${this.cells[cell]} cell=${cell}`);
            }
            const index = this.cells[cell];
            if (index < 0) continue;
            if (distance < -this.entrySpan) continue;
            const rider = riders[index];
            const lane = this.laneOffset(cell);
            rider.active = true;
            if (distance < 0) {
                this.place(rider, this.entry, 1 + distance / this.entrySpan, lane, true);
            } else {
                const percent = this.wrap(this.merge + distance);
                this.place(rider, this.ring, percent, lane, true);
                if (cell % rowWidth === 0 && percent >= this.paths.exitStartPercent && percent <= this.paths.exitEndPercent) this.exitCells.push(cell);
            }
            setMoving(index, true);
        }
        for (const [rider, cell] of this.reservedCells) {
            const percent = this.wrap(this.merge + this.front - this.step * Math.floor(cell / rowWidth));
            this.place(riders[rider], this.ring, percent, this.laneOffset(cell), true);
        }
        for (let i = this.admitted; i < riders.length; i++) {
            const distance = Math.min(0, this.front - 1) - this.step * (1 + Math.floor((i - this.admitted) / rowWidth));
            if (distance < -this.entrySpan) continue;
            const lane = this.laneOffset(i - this.admitted);
            riders[i].active = true;
            this.place(riders[i], this.entry, 1 + distance / this.entrySpan, lane, true);
            setMoving(i, filling);
        }
        return !filling;
    }

    get occupiedCells(): readonly number[] { return this.cells; }

    canCheckFailure(total: number): boolean {
        return this.admitted === total || this.cells.indexOf(-1) < 0;
    }

    passengerAt(cell: number): number { return this.cells[cell]; }

    distanceToExitEnd(cell: number): number {
        const percent = this.merge + this.front - this.step * Math.floor(cell / rowWidth);
        return this.wrap(this.paths.exitEndPercent - percent);
    }

    boostForRemainingVehicles(remaining: number): void {
        if (remaining > 4 || this.boosted) return;
        this.boosted = true;
        log(`[OwnedGameplay] belt-boost remaining=${remaining}`);
    }

    reserveGroup(cell: number): number[] {
        const members = this.cells.slice(cell, cell + rowWidth);
        members.forEach((rider, offset) => this.reservedCells.set(rider, cell + offset));
        this.cells.fill(-1, cell, cell + rowWidth);
        return members;
    }

    leaveForVehicle(rider: number): void {
        this.reservedCells.delete(rider);
    }

    private laneOffset(cell: number): number {
        return (cell % rowWidth - (rowWidth - 1) / 2) * laneSpacing;
    }

    private length(points: readonly Vec3[]): number {
        return points.slice(1).reduce((sum, point, index) => sum + Vec3.distance(points[index], point), 0);
    }

    private wrap(percent: number): number {
        return percent - Math.floor(percent);
    }

    private place(rider: Node, points: readonly Vec3[], percent: number, lane: number, moving: boolean): void {
        const sample = percent * (points.length - 1);
        const first = Math.min(Math.floor(sample), points.length - 2);
        const start = points[first];
        const end = points[first + 1];
        Vec3.lerp(this.sample, start, end, sample - first);
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const run = Math.hypot(dx, dz);
        if (run > 0) {
            this.sample.add3f(lane * dz / run, 0, -lane * dx / run);
            if (moving) rider.setRotationFromEuler(0, Math.atan2(dx, dz) * 180 / Math.PI, 0);
        }
        rider.setPosition(this.sample);
    }
}
