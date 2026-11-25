import { log, Material, MeshRenderer, Node, Quat, Texture2D, Tween, tween, utils, Vec3, Vec4 } from 'cc';
import { originalTextureMaterial } from './OwnedArtAssets';

interface Puff {
    node: Node;
    renderer: MeshRenderer;
    age: number;
    lifetime: number;
    size: number;
    opacity: number;
}

interface Emitter {
    previous: Vec3;
    carry: number;
    emitted: number;
}

const emissionSpacing = 1 / 25;
const opacitySteps = 8;

export class VehicleDrive {
    private readonly emitters = new Map<Node, Emitter>();
    private readonly puffs: Puff[] = [];
    private readonly opacity: Material[];
    private readonly mesh = utils.MeshUtils.createMesh({
        positions: [-0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5],
        uvs: [0, 1, 1, 1, 0, 0, 1, 0],
        indices: [0, 2, 1, 1, 2, 3],
    });
    private readonly position = new Vec3();
    private readonly tangent = new Vec3();
    private readonly emitterPoint = new Vec3();

    constructor(private readonly ground: Node, texture: Texture2D) {
        this.opacity = Array.from({ length: opacitySteps + 1 }, (_, index) => {
            const material = originalTextureMaterial(texture, true);
            material.setProperty('mainColor', new Vec4(1, 1, 1, index / opacitySteps));
            return material;
        });
    }

    enter(car: Node, destination: Vec3, bayRotation: Quat, duration: number, done: () => void): void {
        const start = car.position.clone();
        const heading = this.heading(car.rotation);
        // The authored slot axis points out of the bay. The vehicle faces into the bay.
        const intoBay = this.heading(bayRotation).multiplyScalar(-1);
        if (heading.z < -0.9) {
            // Downward arrows leave below the last row, then return up the outside lane.
            const side = destination.x >= start.x ? 2.25 : -2.25;
            const bend = new Vec3(start.x, start.y, Math.min(start.z - 0.4, -5.35));
            const edge = new Vec3(side, start.y, bend.z + 0.48);
            const lane = new Vec3(side, start.y, destination.z - 0.64);
            this.startEmission(car);
            tween(car).then(this.line(car, start, bend, 0.20))
                .then(this.segment(car, bend, bend.clone().add3f(0, 0, -0.65),
                    edge.clone().add3f(0, 0, -0.8), edge, 0.18))
                .then(this.line(car, edge, lane, 0.22))
                .then(this.segment(car, lane, lane.clone().add3f(0, 0, 0.38),
                    destination.clone().subtract(intoBay.multiplyScalar(0.45)), destination, 0.20))
                .call(() => this.finish(car, 'enter', done)).start();
            return;
        }
        const distance = Vec3.distance(start, destination);
        const bound = heading.x > 0 ? 2.1 : -2.1;
        const toBoundary = Math.abs(heading.x) > 0.01 ? (bound - start.x) / heading.x : Infinity;
        const leadDistance = Math.min(2.42, distance * 0.78, toBoundary);
        const lead = start.clone().add(heading.clone().multiplyScalar(leadDistance));
        const curveStart = lead.clone().add(heading.clone().multiplyScalar(0.29));
        const curveEnd = destination.clone().subtract(intoBay.clone().multiplyScalar(0.73));
        this.startEmission(car);
        const leadTime = duration * (0.22 / 0.56);
        tween(car).then(this.line(car, start, lead, leadTime))
            .then(this.segment(car, lead, curveStart, curveEnd, destination, duration - leadTime))
            .call(() => this.finish(car, 'enter', done)).start();
    }

    exit(car: Node, done: () => void): void {
        const start = car.position.clone();
        const reverseHeading = this.heading(car.rotation).multiplyScalar(-1);
        const back = start.clone().add(reverseHeading.clone().multiplyScalar(0.52));
        const lane = start.clone().add3f(0.27, 0, -0.58);
        const curveStart = back.clone().add(reverseHeading.clone().multiplyScalar(0.16));
        const curveEnd = lane.clone().add3f(-0.28, 0, 0);
        const offscreen = new Vec3(-3.25, lane.y, lane.z);
        this.startEmission(car);
        tween(car).then(this.line(car, start, back, 0.16, true))
            .then(this.segment(car, back, curveStart, curveEnd, lane, 0.23, true))
            .delay(0.10)
            .then(this.line(car, lane, offscreen, 0.48, false, 'quadIn'))
            .call(() => this.finish(car, 'exit', done)).start();
    }

    update(dt: number): void {
        for (const puff of this.puffs) {
            if (!puff.node.active) continue;
            puff.age += dt;
            const progress = puff.age / puff.lifetime;
            if (progress >= 1) {
                puff.node.active = false;
                continue;
            }
            const fadeIn = Math.min(1, progress / 0.09117);
            const fadeOut = Math.min(1, (1 - progress) / 0.34705);
            const index = Math.round(Math.min(fadeIn, fadeOut) * opacitySteps);
            if (index !== puff.opacity) {
                puff.opacity = index;
                puff.renderer.setSharedMaterial(this.opacity[index], 0);
            }
            const size = puff.size * (progress < 0.12
                ? 0.606 + progress * 3.27 : progress < 0.53 ? 1 : 1 - (progress - 0.53) * 1.53);
            puff.node.setScale(size, 1, size);
        }
    }

    reset(): void {
        this.emitters.clear();
        this.puffs.forEach(({ node }) => { node.active = false; });
    }

    destroy(): void {
        this.reset();
        this.mesh.destroy();
        this.opacity.forEach((material) => material.destroy());
    }

    private heading(rotation: Quat): Vec3 {
        return Vec3.transformQuat(new Vec3(), Vec3.UNIT_Z, rotation);
    }

    private line(car: Node, from: Vec3, to: Vec3, duration: number, reverse = false, easing?: 'quadIn'): Tween<Node> {
        const first = Vec3.lerp(new Vec3(), from, to, 1 / 3);
        const last = Vec3.lerp(new Vec3(), from, to, 2 / 3);
        return this.segment(car, from, first, last, to, duration, reverse, easing);
    }

    private segment(car: Node, from: Vec3, first: Vec3, last: Vec3, to: Vec3, duration: number,
        reverse = false, easing?: 'quadIn',
    ): Tween<Node> {
        return tween(car).to(duration, { position: to }, {
            onUpdate: (_, ratio) => {
                const progress = ratio ?? 0;
                const t = easing === 'quadIn' ? progress * progress : progress;
                const rest = 1 - t;
                const a = rest ** 3;
                const b = 3 * rest * rest * t;
                const c = 3 * rest * t * t;
                const d = t ** 3;
                this.position.set(
                    a * from.x + b * first.x + c * last.x + d * to.x,
                    a * from.y + b * first.y + c * last.y + d * to.y,
                    a * from.z + b * first.z + c * last.z + d * to.z,
                );
                this.tangent.set(
                    rest * rest * (first.x - from.x) + 2 * rest * t * (last.x - first.x) + t * t * (to.x - last.x),
                    0,
                    rest * rest * (first.z - from.z) + 2 * rest * t * (last.z - first.z) + t * t * (to.z - last.z),
                );
                if (this.tangent.lengthSqr() < 0.0000001) return;
                this.tangent.normalize().multiplyScalar(reverse ? -1 : 1);
                car.setPosition(this.position);
                car.setRotationFromEuler(0, Math.atan2(this.tangent.x, this.tangent.z) * 180 / Math.PI, 0);
                this.emitterPoint.set(this.position).add3f(-0.25 * this.tangent.x, 0.05, -0.25 * this.tangent.z);
                this.emit(car);
            },
        });
    }

    private startEmission(car: Node): void {
        const forward = this.heading(car.rotation);
        const tail = car.position.clone().add3f(-0.25 * forward.x, 0.05, -0.25 * forward.z);
        this.emitters.set(car, { previous: tail, carry: 0, emitted: 0 });
    }

    private emit(car: Node): void {
        const emitter = this.emitters.get(car)!;
        const distance = Vec3.distance(emitter.previous, this.emitterPoint);
        if (!distance) return;
        let next = emissionSpacing - emitter.carry;
        while (next <= distance) {
            this.spawn(Vec3.lerp(new Vec3(), emitter.previous, this.emitterPoint, next / distance));
            emitter.emitted++;
            next += emissionSpacing;
        }
        emitter.carry = Math.max(0, distance - (next - emissionSpacing));
        emitter.previous.set(this.emitterPoint);
    }

    private spawn(position: Vec3): void {
        let puff = this.puffs.find(({ node }) => !node.active);
        if (!puff) {
            const node = new Node('Original smoke puff');
            node.parent = this.ground;
            const renderer = node.addComponent(MeshRenderer);
            renderer.mesh = this.mesh;
            puff = { node, renderer, age: 0, lifetime: 0, size: 0, opacity: 0 };
            this.puffs.push(puff);
        }
        puff.age = 0;
        puff.lifetime = 0.20 + Math.random() * 0.10;
        puff.size = 0.06 + Math.random() * 0.09;
        puff.opacity = 0;
        puff.renderer.setSharedMaterial(this.opacity[0], 0);
        puff.node.setPosition(position.add3f((Math.random() - 0.5) * 0.07, 0, (Math.random() - 0.5) * 0.07));
        puff.node.setScale(puff.size, 1, puff.size);
        puff.node.active = true;
    }

    private finish(car: Node, phase: 'enter' | 'exit', done: () => void): void {
        log(`[OwnedGameplay] vehicle-motion ${car.name} ${phase} smoke=${this.emitters.get(car)!.emitted}`);
        this.emitters.delete(car);
        done();
    }
}
