import { Node, Vec3 } from 'cc';

type Position = [number, number, number];

export interface ConveyorPaths {
    exitPercent: number;
    spacing: number;
    ring: Position[];
    entry: Position[];
}

const fillDuration = 4.35;
const rowWidth = 5;
const laneSpacing = 0.119;

export class PassengerConveyor {
    private readonly ring: Vec3[];
    private readonly entry: Vec3[];
    private readonly merge: number;
    private readonly step: number;
    private readonly entrySpan: number;
    private readonly finalFront: number;
    private readonly sample = new Vec3();
    private elapsed = 0;
    private advanced = 0;

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
        this.step = Math.min(paths.spacing / ringLength, 1 / Math.ceil(avatarCount / rowWidth));
        const queueSpan = (avatarCount - 1) * this.step / rowWidth;
        const exit = this.wrap(paths.exitPercent - this.merge);
        // The first row keeps rolling until the last row has cleared the merge.
        this.finalFront = exit + Math.max(0, Math.ceil(queueSpan - exit));
    }

    reset(riders: readonly Node[]): void {
        this.elapsed = 0;
        this.advanced = 0;
        riders.forEach((rider) => { rider.active = false; });
    }

    update(
        dt: number, riders: readonly Node[], departedQueue: number,
        setMoving: (index: number, moving: boolean) => void,
    ): boolean {
        this.elapsed = Math.min(fillDuration, this.elapsed + dt);
        const previous = this.advanced;
        this.advanced = Math.min(departedQueue, this.advanced + dt * 24);
        const filling = this.elapsed < fillDuration;
        const moving = filling || this.advanced > previous;
        const front = (this.finalFront + this.entrySpan) * this.elapsed / fillDuration - this.entrySpan;
        for (let index = departedQueue; index < riders.length; index++) {
            const rider = riders[index];
            const distance = front - this.step * (index - this.advanced) / rowWidth;
            if (distance < -this.entrySpan) continue;
            const lane = (index % rowWidth - (rowWidth - 1) / 2) * laneSpacing;
            rider.active = true;
            if (distance < 0) {
                this.place(rider, this.entry, 1 + distance / this.entrySpan, lane, moving);
            } else {
                this.place(rider, this.ring, this.wrap(this.merge + distance), lane, moving);
            }
            setMoving(index, moving);
        }
        return !filling;
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
