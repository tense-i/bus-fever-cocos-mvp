import { Asset, gfx, Color, EffectAsset, Material, Mesh, Prefab, resources, Texture2D, utils, Vec3, Vec4 } from 'cc';
import type { IDynamicGeometry } from 'cc';

const vertexCount = 471;
const frameCount = 99;

export interface PassengerClip {
    frameStart: number;
    frameCount: number;
    duration: number;
    loop: boolean;
}

export interface PassengerClips {
    idle: PassengerClip;
    move: PassengerClip;
    board: PassengerClip;
}

type SurfaceValues = [number, number, number, number];

interface PassengerSurface {
    baseColor: SurfaceValues;
    shade: SurfaceValues;
    shadeOffset: SurfaceValues;
    specular: SurfaceValues;
    specularColor: SurfaceValues;
    enabled: SurfaceValues;
}

export interface PassengerSurfaceParameters {
    lightDirection: [number, number, number];
    lightColor: SurfaceValues;
    routes: Record<'teal' | 'amber' | 'red', PassengerSurface>;
}

interface CarSurface {
    diffuse: [number, number, number, number];
    specular: number;
    baseColor: [number, number, number, number];
    emissionColor: [number, number, number, number];
}

export interface CarSurfaceParameters {
    blue: CarSurface;
    orange: CarSurface;
    red: CarSurface;
    yellow: CarSurface;
    lightDirection: [number, number, number];
    lightColor: [number, number, number, number];
    indirectSpecular: [number, number, number, number];
}

function halfToNumber(word: number): number {
    const sign = (word & 0x8000) === 0 ? 1 : -1;
    const exponent = (word >>> 10) & 31;
    const mantissa = word & 1023;
    return exponent === 0 ? sign * Math.pow(2, -24) * mantissa
        : sign * Math.pow(2, exponent - 25) * (1024 + mantissa);
}

export function loadOwnedArt<T extends Asset>(path: string, type: new () => T): Promise<T> {
    return new Promise((resolve, reject) => {
        resources.load('owned-art/' + path, type, (error, asset) => error ? reject(error) : resolve(asset));
    });
}

export function loadOwnedModel(name: string): Promise<Prefab> {
    return loadOwnedArt(name + '/' + name, Prefab);
}

export function originalTextureMaterial(texture: Texture2D, transparent = false): Material {
    const material = new Material();
    material.initialize({
        effectName: 'builtin-unlit', technique: transparent ? 1 : 0, defines: { USE_TEXTURE: true },
    });
    material.setProperty('mainTexture', texture);
    return material;
}

export function originalStageMaterial(effect: EffectAsset, texture: Texture2D, alpha = false): Material {
    const material = new Material();
    material.initialize({ effectAsset: effect, technique: alpha ? 1 : 0 });
    material.setProperty('mainTexture', texture);
    return material;
}

export function originalCarMaterial(
    effect: EffectAsset, texture: Texture2D, settings: CarSurfaceParameters, surface: CarSurface,
): Material {
    const material = new Material();
    material.initialize({ effectAsset: effect });
    material.setProperty('mainTexture', texture);
    material.setProperty('surfaceColor', new Vec4(...surface.baseColor));
    material.setProperty('emissionColor', new Vec4(...surface.emissionColor));
    material.setProperty('diffuse', new Vec4(...surface.diffuse));
    material.setProperty('lightDirectionSpecular', new Vec4(...settings.lightDirection, surface.specular));
    material.setProperty('lightColor', new Vec4(...settings.lightColor));
    material.setProperty('indirectSpecular', new Vec4(...settings.indirectSpecular));
    return material;
}

export function passengerMaterial(color: Color): Material {
    const material = new Material();
    material.initialize({ effectName: 'builtin-standard' });
    material.setProperty('mainColor', color);
    material.setProperty('roughness', 0.85);
    return material;
}

export function originalPassengerMaterial(
    effect: EffectAsset, settings: PassengerSurfaceParameters, surface: PassengerSurface,
): Material {
    const material = new Material();
    material.initialize({ effectAsset: effect });
    material.setProperty('baseColor', new Vec4(...surface.baseColor));
    material.setProperty('shade', new Vec4(...surface.shade));
    material.setProperty('shadeOffset', new Vec4(...surface.shadeOffset));
    material.setProperty('specular', new Vec4(...surface.specular));
    material.setProperty('specularColor', new Vec4(...surface.specularColor));
    material.setProperty('enabled', new Vec4(...surface.enabled));
    material.setProperty('lightDirection', new Vec4(...settings.lightDirection, 0));
    material.setProperty('lightColor', new Vec4(...settings.lightColor));
    return material;
}

export class OwnedPassengerVat {
    private readonly frames: Float32Array[];
    private readonly normals: Float32Array;
    private readonly indices: Uint16Array;

    constructor(source: Mesh, buffer: ArrayBuffer) {
        const lookup = source.readAttribute(0, gfx.AttributeName.ATTR_TEX_COORD1);
        const normals = source.readAttribute(0, gfx.AttributeName.ATTR_NORMAL);
        const indices = source.readIndices(0);
        if (!lookup || !normals || !indices || lookup.length !== vertexCount * 2
            || buffer.byteLength !== vertexCount * frameCount * 8) {
            throw new Error('Imported mesh or VAT dimensions do not match the original');
        }
        const ids = Array.from({ length: vertexCount }, (_, i) => Math.floor(Number(lookup[i * 2]) * vertexCount));
        if (Math.min(...ids) < 0 || Math.max(...ids) >= vertexCount || new Set(ids).size !== vertexCount) {
            throw new Error('Vertex lookup was lost or changed during import');
        }
        const view = new DataView(buffer);
        this.frames = Array.from({ length: frameCount }, (_, frame) => {
            const positions = new Float32Array(vertexCount * 3);
            for (let index = 0; index < vertexCount; index++) {
                const offset = (frame * vertexCount + ids[index]) * 8;
                positions[index * 3] = halfToNumber(view.getUint16(offset, true));
                positions[index * 3 + 1] = halfToNumber(view.getUint16(offset + 2, true));
                positions[index * 3 + 2] = -halfToNumber(view.getUint16(offset + 4, true));
            }
            return positions;
        });
        this.normals = new Float32Array(normals);
        this.indices = new Uint16Array(indices);
    }

    play(clip: PassengerClip): OwnedPassengerPlayback {
        if (!Number.isInteger(clip.frameStart) || !Number.isInteger(clip.frameCount)
            || clip.frameStart < 0 || clip.frameCount < 1
            || clip.frameStart + clip.frameCount > this.frames.length
            || !Number.isFinite(clip.duration) || clip.duration <= 0) {
            throw new Error('Invalid original VAT clip bounds or duration');
        }
        return new OwnedPassengerPlayback(this.frames, this.normals, this.indices, clip);
    }
}

export class OwnedPassengerPlayback {
    readonly mesh: Mesh;
    private readonly geometry: IDynamicGeometry;
    private time = 0;
    private displayed: number;

    constructor(
        private readonly frames: Float32Array[],
        normals: Float32Array,
        indices: Uint16Array,
        private readonly clip: PassengerClip,
    ) {
        this.displayed = clip.frameStart;
        this.geometry = {
            positions: this.frames[this.displayed], normals, indices16: indices,
            minPos: new Vec3(-1.5, -0.3, -1.5), maxPos: new Vec3(1.5, 2.5, 1.5),
        };
        this.mesh = utils.MeshUtils.createDynamicMesh(0, this.geometry, undefined, {
            maxSubMeshes: 1, maxSubMeshVertices: vertexCount, maxSubMeshIndices: indices.length,
        });
    }

    advance(dt: number): void {
        const { frameStart, frameCount, duration, loop } = this.clip;
        this.time = loop ? (this.time + dt) % duration : Math.min(this.time + dt, duration);
        const steps = loop ? frameCount : frameCount - 1;
        this.display(frameStart + Math.min(frameCount - 1, Math.floor(this.time / duration * steps)));
    }

    reset(): void {
        this.time = 0;
        this.display(this.clip.frameStart);
    }

    private display(frame: number): void {
        if (this.displayed === frame) return;
        this.displayed = frame;
        this.geometry.positions = this.frames[frame];
        this.mesh.updateSubMesh(0, this.geometry);
    }
}
