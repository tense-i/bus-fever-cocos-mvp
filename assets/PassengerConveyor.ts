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
    otherEntry?: Position[];
}

interface Inlet {
    path: Vec3[];
    merge: number;
    length: number;
    first: number;
    end: number;
    next: number;
}

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
    private readonly inlets: Inlet[] = [];
    private readonly ringLength: number;
    private readonly fillArc: number;
    private readonly sample = new Vec3();
    private elapsed = 0;
    private entryTravelTime = 0;
    private fillDuration = 0;
    private settleRate = 0;
    private speed = normalSpeed;
    private boosted = false;
    private front: number;
    private admitted = 0;
    private readonly cells: number[];
    private readonly reservedCells = new Map<number, number>();
    readonly exitCells: number[] = [];

    constructor(ground: Node, private readonly paths: ConveyorPaths, avatarCount: number, split?: number) {
        const local = ([x, y, z]: Position) => ground.inverseTransformPoint(new Vec3(), new Vec3(-x, y, z));
        this.ring = paths.ring.map(local);
        this.ringLength = this.length(this.ring);
        const inlet = (points: Position[], first: number, end: number): Inlet => {
            const path = points.map(local).reverse();
            const tip = path[path.length - 1];
            let closest = 0;
            for (let i = 1; i < this.ring.length - 1; i++) {
                if (Vec3.squaredDistance(this.ring[i], tip) < Vec3.squaredDistance(this.ring[closest], tip)) closest = i;
            }
            path.push(this.ring[closest]);
            return { path, merge: closest / (this.ring.length - 1), length: this.length(path), first, end, next: first };
        };
        const left = inlet(paths.entry, 0, split ?? avatarCount);
        this.entry = left.path;
        this.merge = left.merge;
        this.entrySpan = left.length / this.ringLength;
        if (paths.otherEntry && split !== undefined) {
            const right = inlet(paths.otherEntry, split, avatarCount);
            this.inlets.push(left, right);
            const arc = this.wrap(right.merge - left.merge);
            this.fillArc = Math.max(arc, 1 - arc);
        } else {
            this.fillArc = 1;
        }
        this.cells = Array(Math.min(avatarCount, paths.capacity * rowWidth)).fill(-1);
        this.step = 1 / paths.capacity;
        this.front = -this.entrySpan;
    }

    reset(riders: readonly Node[], entrySeconds: number, fillSeconds: number, settleRate: number): void {
        this.entryTravelTime = entrySeconds;
        this.fillDuration = fillSeconds;
        this.settleRate = settleRate;
        this.elapsed = 0;
        this.boosted = false;
        this.speed = normalSpeed;
        this.front = -this.entrySpan;
        this.admitted = this.cells.length;
        this.reservedCells.clear();
        this.exitCells.length = 0;
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = i;
        if (this.inlets.length) {
            this.cells.fill(-1);
            this.admitted = 0;
            this.front = -1e-8;
            for (const inlet of this.inlets) inlet.next = inlet.first;
        }
        riders.forEach((rider) => { rider.active = false; });
    }

    update(
        dt: number, riders: readonly Node[],
        setMoving: (index: number, moving: boolean) => void,
    ): boolean {
        if (this.inlets.length) return this.updateDual(dt, riders, setMoving);
        this.elapsed = Math.min(this.fillDuration, this.elapsed + dt);
        const previous = this.front;
        const filling = this.elapsed < this.fillDuration;
        if (this.elapsed < this.entryTravelTime) this.front = this.entrySpan * (this.elapsed / this.entryTravelTime - 1);
        else if (filling) this.front = (this.elapsed - this.entryTravelTime) / (this.fillDuration - this.entryTravelTime);
        else {
            if (previous < 1) this.speed = 1 / (this.fillDuration - this.entryTravelTime);
            this.speed = this.boosted ? boostedSpeed : Math.max(normalSpeed, this.speed - this.settleRate * dt);
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

    private updateDual(dt: number, riders: readonly Node[], setMoving: (id: number, moving: boolean) => void): boolean {
        this.elapsed += dt;
        const previous = this.front;
        const filling = this.elapsed < this.fillDuration;
        if (this.elapsed >= this.entryTravelTime) {
            if (filling) {
                this.front = this.fillArc * (this.elapsed - this.entryTravelTime) / (this.fillDuration - this.entryTravelTime);
            } else {
                if (previous < this.fillArc) this.speed = this.fillArc / (this.fillDuration - this.entryTravelTime);
                const normal = 0.78 / this.ringLength;
                this.speed = this.boosted ? normal * 1.8 : Math.max(normal, this.speed - this.settleRate * dt);
                this.front = Math.max(this.fillArc, previous + this.speed * dt);
            }
        }
        this.exitCells.length = 0;
        for (let cell = 0; cell < this.cells.length; cell += rowWidth) {
            const lag = this.step * (cell / rowWidth);
            const current = this.merge + this.front - lag;
            if (this.cells[cell] < 0) {
                for (const inlet of this.inlets) {
                    const before = this.merge + previous - lag - inlet.merge;
                    if (inlet.next >= inlet.end || Math.floor(current - inlet.merge) <= Math.floor(before)) continue;
                    for (let lane = 0; lane < rowWidth; lane++) this.cells[cell + lane] = inlet.next++;
                    this.admitted += rowWidth;
                    log(`[OwnedGameplay] dual-admit first=${this.cells[cell]} inlet=${inlet.first} cell=${cell}`);
                    break;
                }
            }
            if (this.cells[cell] < 0) continue;
            const percent = this.wrap(current);
            for (let lane = 0; lane < rowWidth; lane++) {
                const id = this.cells[cell + lane];
                riders[id].active = true;
                this.place(riders[id], this.ring, percent, this.laneOffset(lane), true);
                setMoving(id, true);
            }
            if (percent >= this.paths.exitStartPercent && percent <= this.paths.exitEndPercent) this.exitCells.push(cell);
        }
        for (const [rider, cell] of this.reservedCells) {
            const percent = this.wrap(this.merge + this.front - this.step * Math.floor(cell / rowWidth));
            this.place(riders[rider], this.ring, percent, this.laneOffset(cell), true);
        }
        for (const inlet of this.inlets) {
            const head = Math.min(1, this.elapsed / this.entryTravelTime);
            for (let id = inlet.next; id < inlet.end; id++) {
                const offset = id - inlet.next;
                const t = head - Math.floor(offset / rowWidth) * this.paths.spacing / inlet.length;
                if (t < 0) break;
                riders[id].active = true;
                this.place(riders[id], inlet.path, t, this.laneOffset(offset), true);
                setMoving(id, filling);
            }
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
