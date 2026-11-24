import { Node, Vec3 } from 'cc';

type Position = [number, number, number];

export interface ConveyorPaths {
    exitPercent: number;
    spacing: number;
    ring: Position[];
    entry: Position[];
}

const entryDuration = 0.92;
const conveyorDuration = 1.55;
const rowWidth = 3;
const laneSpacing = 0.135;

export class PassengerConveyor {
    private readonly ring: Vec3[];
    private readonly entry: Vec3[];
    private readonly merge: number;
    private readonly step: number;
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
        const length = this.ring.slice(1).reduce((sum, point, index) => sum + Vec3.distance(this.ring[index], point), 0);
        this.step = Math.min(paths.spacing / length, 1 / Math.ceil(avatarCount / rowWidth));
    }

    reset(riders: readonly Node[]): void {
        this.elapsed = 0;
        this.advanced = 0;
        riders.forEach((rider) => { rider.active = false; });
    }

    update(dt: number, riders: readonly Node[], boarded: number, boarding: boolean): boolean {
        this.elapsed += dt;
        this.advanced = Math.min(boarded, this.advanced + dt * 12);
        let settled = true;
        for (let index = boarded; index < riders.length; index++) {
            if (boarding && index === boarded) continue;
            const rider = riders[index];
            const lane = (index % rowWidth - 1) * laneSpacing;
            const time = this.elapsed - Math.floor(index / rowWidth) * 0.062 - index % rowWidth * 0.023;
            const destination = this.paths.exitPercent - this.step * (index - this.advanced) / rowWidth;
            const distance = this.wrap(destination - this.merge);
            if (time < 0) {
                settled = false;
                continue;
            }
            rider.active = true;
            if (time < entryDuration) {
                this.place(rider, this.entry, time / entryDuration, lane);
                settled = false;
                continue;
            }
            const traveled = (time - entryDuration) / conveyorDuration;
            this.place(rider, this.ring, this.wrap(this.merge + Math.min(traveled, distance)), lane);
            settled &&= traveled >= distance;
        }
        return settled;
    }

    private wrap(percent: number): number {
        return percent - Math.floor(percent);
    }

    private place(rider: Node, points: readonly Vec3[], percent: number, lane: number): void {
        const sample = percent * (points.length - 1);
        const first = Math.min(Math.floor(sample), points.length - 2);
        const start = points[first];
        const end = points[first + 1];
        Vec3.lerp(this.sample, start, end, sample - first);
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const run = Math.hypot(dx, dz);
        if (run > 0) this.sample.add3f(lane * dz / run, 0, -lane * dx / run);
        rider.setPosition(this.sample);
    }
}
