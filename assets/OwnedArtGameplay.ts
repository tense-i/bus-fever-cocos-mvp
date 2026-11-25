import {
    _decorator, BufferAsset, Camera, Canvas, Color, Component, DirectionalLight, EffectAsset, EventTouch,
    geometry, gfx, input, Input, instantiate, isValid, JsonAsset, Label, Layers, log, Material,
    Mesh, MeshRenderer, Node, Prefab, profiler, Quat, Sprite, SpriteFrame, Texture2D,
    Tween, tween, UITransform, utils, Vec3, Vec4, view,
} from 'cc';
import { AuthoredBoard, makeThirdLevel, vehicleSeats, BusLevel, BusRoute, extraRoutes, levelOne as firstLevel, levelTwo, secondPaintGain, StagedVehicle } from './BusLevels';
import { LevelOneDispatch, levelOneBayCount, levelOneSeats } from './LevelOneDispatch';
import {
    CarSurfaceParameters, loadOwnedArt, loadOwnedModel, originalCarMaterial, originalPassengerMaterial,
    originalStageMaterial, originalTextureMaterial, OwnedPassengerPlayback, OwnedPassengerVat, PassengerClips,
    PassengerSurfaceParameters,
} from './OwnedArtAssets';
import { loadResultArt, OwnedResultPanels, RatingLayout } from './OwnedResultPanels';
import { ConveyorPaths, PassengerConveyor } from './PassengerConveyor';
import { distanceToBlocker, VehicleFootprint } from './VehicleFootprint';
import { VehicleDrive } from './VehicleDrive';

const { ccclass } = _decorator;
const stageFov = 4.7;
// Framing measured against the 480-line Level 1 reference after centering its portrait crop.
const referenceHeight = 480;
const referenceOffset = { x: 1, y: 17 };

interface Pose {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
}

interface ScenePoses {
    camera: Pose;
    backdrop: Pose;
    ground: Pose;
    parking: Pose;
}

interface LevelOneScene {
    conveyor: { root: Pose; sprite: Pose; bounds: [number, number, number, number] };
    parking: (Pose & { name: string })[];
    vipBase: Pose;
    vipMark: Pose;
    queue: ConveyorPaths;
}

interface HudPlacement {
    anchor: [number, number];
    position: [number, number];
    size: [number, number];
}

interface HudLayout {
    level: HudPlacement;
    replay: HudPlacement;
}

interface ShadowPlacement {
    pose: Pose;
    alpha: number;
}

interface ShadowLayout {
    passenger: ShadowPlacement;
    passengerRoot: Pose;
}

interface VehicleBoardClip {
    duration: number;
    segments: { time: number; coefficients: [number, number, number, number] }[];
}

const stationScale = new Vec3(0.14062501, 0.14062501, 0.14498439);
const vehicleBounds = new geometry.AABB(0, 1.16905, 0.01159, 1.08962, 0.98017, 2.32677);
interface BodyShape {
    scale: [number, number, number];
    boxSize: [number, number, number];
    boxCenter: [number, number, number];
    arrow: Pose;
}

interface BodyArt {
    body: Prefab;
    wheel: Prefab;
    shadow: Prefab;
    shadowMaterial: Material;
    shape: BodyShape;
}

const arrowPose: Pose = {
    position: [0, 2.1400001, 0.079999998], rotation: [0, 1, 0, 0], scale: [1.125, 1.125, 1.125],
};
const seatBadgePose: Pose = {
    position: [0.075999998, -0.101, 0.486000002],
    rotation: [0.140974447, 0.184593737, -0.026764831, 0.972283423],
    scale: [1, 1, 1],
};
const passengerInterval = 0.04;
// BusJamConfig.passengerGroupAboardSpeed and parkingSpotPassengerStopPoint (mirrored X).
const boardingSpeed = 3.8;
const boardingStop = new Vec3(0.05, -0.05, -0.08);
const guideStart = 1.2;

interface ParkingBay {
    boardingPoint: Vec3;
    position: Vec3;
    rotation: Quat;
    badge: Node;
    badgeLabel: Label;
}

function originalPose(node: Node, pose: Pose): void {
    const [x, y, z] = pose.position;
    const [qx, qy, qz, qw] = pose.rotation;
    node.setPosition(-x, y, z);
    node.setRotation(new Quat(qx, -qy, -qz, qw));
    node.setScale(...pose.scale);
}

@ccclass('OwnedArtGameplay')
export class OwnedArtGameplay extends Component {
    private level: BusLevel = firstLevel;
    private round = new LevelOneDispatch(this.level);
    private buildActors!: () => void;
    private sky!: Node;
    private plane!: Node;
    private nextTitle?: Node;
    private thirdTitle?: Node;
    private thirdBoard?: BusLevel;
    private loadThirdArt!: () => Promise<void>;
    private switchConveyor!: () => void;
    private conveyorRoot?: Node;
    private readonly bodyArt = new Map<number, BodyArt>();
    private loadNextArt!: () => Promise<void>;
    private nextArt?: Promise<void>;
    private readonly adSlots: Node[] = [];
    private showAdMarks!: () => void;
    private transitioning = false;
    private root!: Node;
    private ground!: Node;
    private camera!: Camera;
    private idle?: OwnedPassengerPlayback;
    private moving?: OwnedPassengerPlayback;
    private boarding?: OwnedPassengerPlayback;
    private boardingClock = 0;
    private resultShown = false;
    private vehicleBoardClip!: VehicleBoardClip;
    private vehicleBoarding?: { model: Node; elapsed: number };
    private vehicleModels = new Map<string, { bodyAndWheels: Node; arrow: Node; outline: Node }>();
    private materials: Material[] = [];
    private readonly contacting = new Set<string>();
    private cars = new Map<string, Node>();
    private riders: Node[] = [];
    private riderRenderers: MeshRenderer[] = [];
    private bays: ParkingBay[] = [];
    private seatMaterials!: Record<BusRoute, Material>;
    private conveyor?: PassengerConveyor;
    private vehicleDrive?: VehicleDrive;
    private introReady = false;
    private paused = false;
    private pauseNode?: Node;
    private guideHand?: Node;
    private guideCircle?: Node;
    private guideCaption?: Label;
    private guideCard?: Node;
    private guideClock = 0;
    private tutorialComplete = false;
    private propNodes: Node[] = [];
    private conveyorMesh?: Mesh;
    private ready = false;
    private status!: Label;
    private resultPanels?: OwnedResultPanels;
    private replayNode?: Node;
    private levelTitle?: Node;
    private hud?: HudLayout;

    onLoad(): void {
        profiler.hideStats();
        this.status = this.label('Loading', 401, 22);
        const hud = this.getComponent(Canvas)!.cameraComponent!;
        hud.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        hud.priority = 1;
        this.root = new Node('Original GameScene');
        this.root.parent = this.node.scene;
        input.on(Input.EventType.TOUCH_END, this.onTouch, this);
        void this.loadStage().catch((error: unknown) => {
            if (!isValid(this, true)) return;
            this.status.string = 'Asset load failed';
            console.error('[OwnedGameplay] ' + String(error));
        });
    }

    update(dt: number): void {
        if (this.paused || this.transitioning) return;
        this.vehicleDrive?.update(dt);
        this.resultPanels?.update(dt);
        if (this.ready && this.conveyor) {
            const settled = this.conveyor.update(
                dt, this.riders, this.setConveyorMotion,
            );
            if (settled && !this.introReady) {
                this.introReady = true;
                log(`[OwnedGameplay] passengers-in-ring ${this.round.totalPassengers} avatars=${this.riders.length}`);
            }
            this.updateGuide(dt);
        }
        this.idle?.advance(dt);
        this.moving?.advance(dt);
        if (this.ready && (this.tutorialComplete || this.guideClock >= guideStart) && !this.resultShown) {
            this.boardingClock += dt;
            if (this.round.boarded < this.round.consumed) this.boarding?.advance(dt);
            this.playAvailableBoarding();
        }
        const boarding = this.vehicleBoarding;
        if (!boarding) return;
        boarding.elapsed += dt;
        if (boarding.elapsed >= this.vehicleBoardClip.duration) {
            boarding.model.setScale(1, 1, 1);
            this.vehicleBoarding = undefined;
            return;
        }
        const [first, second] = this.vehicleBoardClip.segments;
        const segment = boarding.elapsed < second.time ? first : second;
        const [a, b, c, d] = segment.coefficients;
        const t = boarding.elapsed - segment.time;
        const scale = ((a * t + b) * t + c) * t + d;
        boarding.model.setScale(scale, scale, scale);
    }

    onDestroy(): void {
        input.off(Input.EventType.TOUCH_END, this.onTouch, this);
        this.stopMoves();
        if (this.sky) Tween.stopAllByTarget(this.sky);
        if (this.plane) Tween.stopAllByTarget(this.plane);
        this.vehicleDrive?.destroy();
        this.resultPanels?.destroy();
        this.root.destroy();
        this.idle?.mesh.destroy();
        this.moving?.mesh.destroy();
        this.boarding?.mesh.destroy();
        this.conveyorMesh?.destroy();
        this.materials.forEach((material) => material.destroy());
    }

    private async loadStage(): Promise<void> {
        const [
            body, wheel, passenger, background, parking, vat, blue, yellow, red, backdropMap, parkingMap, replay,
            layout, clipData, carEffect, surfaceData, resultArt, level, hudData, arrow,
            shadowAssets, vehicleBoardClip, levelOneAssets, onboardingArt, badge, badgeMap, vehicleSmoke, stageEffect,
            passengerEffect, passengerData,
        ] =
            await Promise.all([
                loadOwnedModel('bus-long-body'), loadOwnedModel('bus-long-wheel'),
                loadOwnedModel('passenger-idle-indexed'), loadOwnedModel('scene-backdrop'), loadOwnedModel('parking-spot'),
                loadOwnedArt('passenger-idle-positions', BufferAsset),
                loadOwnedArt('bus-base-map/texture', Texture2D), loadOwnedArt('bus-yellow-map/texture', Texture2D),
                loadOwnedArt('bus-red-map/texture', Texture2D),
                loadOwnedArt('scene-backdrop-map/texture', Texture2D), loadOwnedArt('parking-spot-map/texture', Texture2D),
                loadOwnedArt('replay-icon/texture', Texture2D), loadOwnedArt('scene-poses', JsonAsset),
                loadOwnedArt('passenger-clips', JsonAsset), loadOwnedArt('car-surface', EffectAsset),
                loadOwnedArt('car-surface-parameters', JsonAsset),
                loadResultArt(),
                loadOwnedArt('level-title/texture', Texture2D), loadOwnedArt('game-hud-layout', JsonAsset),
                loadOwnedModel('arrow-01'),
                Promise.all([
                    loadOwnedModel('bus-long-shadow'), loadOwnedModel('passenger-shadow'),
                    loadOwnedArt('bus-long-shadow-map/texture', Texture2D),
                    loadOwnedArt('passenger-shadow-material/texture', Texture2D),
                    loadOwnedArt('shadow-layout', JsonAsset),
                ]),
                loadOwnedArt('vehicle-board-clip', JsonAsset),
                Promise.all([
                    loadOwnedArt('level-one-scene', JsonAsset), loadOwnedArt('level-one-conveyor/texture', Texture2D),
                    loadOwnedModel('parking-vip-mark'), loadOwnedArt('parking-vip-map/texture', Texture2D),
                ]),
                Promise.all([
                    loadOwnedArt('tutorial-hand/texture', Texture2D), loadOwnedArt('tutorial-circle/texture', Texture2D),
                    loadOwnedArt('pause-icon/texture', Texture2D), loadOwnedArt('locked-prop-button/texture', Texture2D),
                    loadOwnedArt('locked-prop-padlock/texture', Texture2D),
                    loadOwnedArt('locked-prop-body/texture', Texture2D),
                    loadOwnedArt('tutorial-panel/texture', Texture2D),
                ]),
                loadOwnedModel('bay-seat-badge'), loadOwnedArt('bay-seat-badge-map/texture', Texture2D),
                loadOwnedArt('vehicle-smoke/texture', Texture2D),
                loadOwnedArt('stage-art', EffectAsset),
                loadOwnedArt('passenger-surface', EffectAsset),
                loadOwnedArt('passenger-surface-parameters', JsonAsset),
            ]);
        if (!isValid(this, true)) return;
        const [carShadow, passengerShadow, carShadowMap, passengerShadowMap, shadowData] = shadowAssets;
        const shadows = shadowData.json as unknown as ShadowLayout;
        const poses = layout.json as unknown as ScenePoses;
        const [levelOneData, road, vipMark, vipMap] = levelOneAssets;
        const levelOne = levelOneData.json as unknown as LevelOneScene;
        const clips = clipData.json as unknown as PassengerClips;
        const surfaces = surfaceData.json as unknown as CarSurfaceParameters;
        this.hud = hudData.json as unknown as HudLayout;
        this.vehicleBoardClip = vehicleBoardClip.json as unknown as VehicleBoardClip;
        const busMaterials = {
            teal: originalCarMaterial(carEffect, blue, surfaces, surfaces.blue),
            amber: originalCarMaterial(carEffect, yellow, surfaces, surfaces.yellow),
            red: originalCarMaterial(carEffect, red, surfaces, surfaces.red),
        };
        const pavementMaterial = originalTextureMaterial(parkingMap);
        const backdropMaterial = originalStageMaterial(stageEffect, backdropMap);
        const roadMaterial = originalStageMaterial(stageEffect, road, true);
        const vipMaterial = originalTextureMaterial(vipMap);
        const arrowMaterial = originalTextureMaterial(blue, true);
        const carShadowMaterial = this.shadowMaterial(carShadowMap, 0.8);
        const passengerShadowMaterial = this.shadowMaterial(passengerShadowMap, shadows.passenger.alpha);
        this.seatMaterials = {
            teal: this.badgeMaterial(badgeMap, new Vec4(0.12, 0.60, 0.92, 1)),
            amber: this.badgeMaterial(badgeMap, new Vec4(0.96, 0.67, 0.14, 1)),
            red: this.badgeMaterial(badgeMap, new Vec4(0.93, 0.20, 0.28, 1)),
        } as Record<BusRoute, Material>;
        const passengerSurfaces = passengerData.json as unknown as PassengerSurfaceParameters;
        const riderMaterials = {
            teal: originalPassengerMaterial(passengerEffect, passengerSurfaces, passengerSurfaces.routes.teal),
            amber: originalPassengerMaterial(passengerEffect, passengerSurfaces, passengerSurfaces.routes.amber),
            red: originalPassengerMaterial(passengerEffect, passengerSurfaces, passengerSurfaces.routes.red),
        };
        const highlight = new Material();
        highlight.initialize({ effectName: 'builtin-unlit', states: { rasterizerState: { cullMode: gfx.CullMode.FRONT } } });
        highlight.setProperty('mainColor', new Color(255, 228, 0));
        this.materials = [
            highlight,
            ...Object.values(busMaterials), pavementMaterial, backdropMaterial, roadMaterial, vipMaterial,
            arrowMaterial, ...Object.values(riderMaterials), carShadowMaterial, passengerShadowMaterial,
            ...Object.values(this.seatMaterials),
        ];

        this.createScene(poses, background, parking, backdropMaterial, pavementMaterial, levelOne, vipMark, vipMaterial, badge);
        this.vehicleDrive = new VehicleDrive(this.ground, vehicleSmoke);
        this.createConveyor(levelOne, roadMaterial);
        this.bodyArt.set(10, { body, wheel, shadow: carShadow, shadowMaterial: carShadowMaterial, shape: {
            scale: [stationScale.x, stationScale.y, stationScale.z], boxSize: [1.92, 2.63148, 4.68043],
            boxCenter: [0, 1.31574, 0], arrow: arrowPose,
        } });
        const thirdPaint = new Map<BusRoute, Material>();
        this.buildActors = () => {
            this.level.fleet.forEach((vehicle) => {
                const art = this.bodyArt.get(vehicle.groups ?? 10)!;
                const car = new Node(vehicle.id);
                car.parent = this.ground;
                const bodyAndWheels = new Node('Bus_001 and Wheel_001');
                bodyAndWheels.parent = car;
                const standardPaint = (busMaterials as Record<BusRoute, Material>)[vehicle.route];
                const paint = this.level.number === 3 ? thirdPaint.get(vehicle.route)! : standardPaint;
                const bodyNode = this.model(art.body, bodyAndWheels, paint);
                this.model(art.wheel, bodyAndWheels, paint);
                const arrowNode = this.model(arrow, bodyNode, arrowMaterial);
                originalPose(arrowNode, art.shape.arrow);
                const outline = this.model(art.body, bodyAndWheels, highlight);
                outline.setScale(1.13, 1.08, 1.07);
                outline.active = false;
                this.vehicleModels.set(vehicle.id, { bodyAndWheels, arrow: arrowNode, outline });
                const shadow = this.model(art.shadow, car, art.shadowMaterial);
                this.model(art.shadow, shadow, art.shadowMaterial);
                this.cars.set(vehicle.id, car);
            });
            this.riders = this.round.queue.map((route, index) => {
                const material = (riderMaterials as Record<BusRoute, Material>)[route];
                const existing = this.riders[index];
                if (existing) {
                    const renderer = this.riderRenderers[index];
                    renderer.setSharedMaterial(material, 0);
                    renderer.mesh = this.idle!.mesh;
                    return existing;
                }
                const rider = new Node('Passenger facing');
                rider.parent = this.ground;
                const pose = new Node('Passenger pose');
                pose.parent = rider;
                originalPose(pose, shadows.passengerRoot);
                const body = this.model(passenger, pose, material);
                // The indexed VAT GLB reflects Z. Other prefab meshes reflect X.
                body.setRotationFromEuler(0, 180, 0);
                originalPose(this.model(passengerShadow, pose, passengerShadowMaterial), shadows.passenger.pose);
                const renderer = body.getComponentInChildren(MeshRenderer)!;
                if (!this.idle) {
                    const frames = new OwnedPassengerVat(renderer.mesh!, vat.buffer());
                    this.idle = frames.play(clips.idle);
                    this.moving = frames.play(clips.move);
                    this.boarding = frames.play(clips.board);
                }
                renderer.mesh = this.idle.mesh;
                this.riderRenderers.push(renderer);
                return rider;
            });
        };
        this.buildActors();
        this.levelTitle = this.makeImage('Original Level_Text', level);
        this.positionHud(this.levelTitle, this.hud.level);
        this.createOnboardingHud(...onboardingArt);
        this.resultPanels = new OwnedResultPanels(this.node, resultArt, () => this.reset('restart'), () => this.advanceLevel());
        this.replayNode = this.makeImage('Original replay icon', replay);
        this.replayNode.on(Node.EventType.TOUCH_END, () => this.reset('restart'));
        this.loadNextArt = async () => {
            const [secondArt, secondPaint, skyMap, planeMap, secondTitle, adMark, adMap] = await Promise.all([
                loadOwnedArt('level-two-art', JsonAsset),
                Promise.all(extraRoutes.map(route => loadOwnedArt('bus-' + route + '-map/texture', Texture2D))),
                loadOwnedArt('transition-sky/texture', Texture2D), loadOwnedArt('transition-plane/texture', Texture2D),
                loadOwnedArt('level-two-title/texture', Texture2D), loadOwnedModel('parking-add'),
                loadOwnedArt('parking-ad-map/texture', Texture2D),
            ]);
            if (!isValid(this, true)) return;
            const second = secondArt.json as {
                cars: Record<typeof extraRoutes[number], CarSurfaceParameters['orange']>;
                riders: Record<typeof extraRoutes[number], [number, number, number, number]>;
            };
            for (const [index, route] of extraRoutes.entries()) {
                const paint = originalCarMaterial(carEffect, secondPaint[index], surfaces, second.cars[route]);
                paint.setProperty('displayGain', new Vec4(...secondPaintGain[route], 1));
                (busMaterials as Record<BusRoute, Material>)[route] = paint;
            }
            for (const route of extraRoutes) {
                const color = second.riders[route];
                (riderMaterials as Record<BusRoute, Material>)[route] = originalPassengerMaterial(passengerEffect, passengerSurfaces,
                    { ...passengerSurfaces.routes.teal, baseColor: color });
                this.seatMaterials[route] = this.badgeMaterial(badgeMap, new Vec4(...color));
            }
            const adMaterial = originalTextureMaterial(adMap);
            this.nextTitle = this.makeImage('Original Level 2 title', secondTitle);
            this.positionHud(this.nextTitle, this.hud!.level);
            this.nextTitle.active = false;
            this.sky = this.makeImage('Original sky transition', skyMap);
            this.plane = this.makeImage('Original transition aircraft', planeMap);
            this.plane.parent = this.sky;
            this.sky.active = false;
            this.materials.push(adMaterial);
            for (const route of extraRoutes) {
                this.materials.push((busMaterials as Record<BusRoute, Material>)[route],
                    (riderMaterials as Record<BusRoute, Material>)[route], this.seatMaterials[route]);
            }
            this.showAdMarks = () => {
                for (const bay of this.adSlots) {
                    bay.getComponentsInChildren(MeshRenderer).forEach(r => r.setSharedMaterial(adMaterial, 0));
                    this.model(adMark, bay, adMaterial);
                }
            };
        };
        this.loadThirdArt = async () => {
            const [config, road, title, smallBody, smallWheel, smallShadow, smallShadowMap,
                vanBody, vanWheel, vanShadow, vanShadowMap, ratingTexture] = await Promise.all([
                loadOwnedArt('level-three', JsonAsset), loadOwnedArt('level-three-conveyor/texture', Texture2D),
                loadOwnedArt('level-three-title/texture', Texture2D), loadOwnedModel('bus-body'),
                loadOwnedModel('bus-wheel'), loadOwnedModel('car-shadow'), loadOwnedArt('car-shadow-material/texture', Texture2D),
                loadOwnedModel('van-body'), loadOwnedModel('van-wheel'), loadOwnedModel('van-shadow'),
                loadOwnedArt('van-shadow-map/texture', Texture2D), loadOwnedArt('third-rating/texture', Texture2D),
            ]);
            if (!isValid(this, true)) return;
            const data = config.json as AuthoredBoard & Pick<LevelOneScene, 'conveyor' | 'queue'> & { shapes: Record<number, BodyShape>; rating: RatingLayout };
            // Measured against the parked roofs in the third-board reference frame.
            for (const [route, gain] of [['teal', [0.78, 0.91, 1.10]], ['amber', [1.17, 1.07, 0.63]],
                ['red', [1.03, 0.38, 0.65]]] as const) {
                const paint = new Material();
                paint.copy(busMaterials[route]);
                paint.setProperty('displayGain', new Vec4(...gain, 1));
                thirdPaint.set(route, paint);
                this.materials.push(paint);
            }
            this.thirdBoard = makeThirdLevel(data);
            this.resultPanels!.prepareRating(ratingTexture, data.rating);
            const smallMat = this.shadowMaterial(smallShadowMap, 0.8);
            const vanMat = this.shadowMaterial(vanShadowMap, 0.8);
            const roadMat = originalStageMaterial(stageEffect, road, true);
            this.materials.push(smallMat, vanMat, roadMat);
            this.bodyArt.set(4, { body: smallBody, wheel: smallWheel, shadow: smallShadow, shadowMaterial: smallMat, shape: data.shapes[4] });
            this.bodyArt.set(6, { body: vanBody, wheel: vanWheel, shadow: vanShadow, shadowMaterial: vanMat, shape: data.shapes[6] });
            this.thirdTitle = this.makeImage('Original Level 3 title', title);
            this.positionHud(this.thirdTitle, this.hud!.level);
            this.thirdTitle.active = false;
            this.switchConveyor = () => this.createConveyor(data, roadMat, data.streams[0].reduce((n, wave) => n + wave[1], 0));
        };
        this.ready = true;
        log('[OwnedGameplay] campaign boards=3');
        log(`[OwnedGameplay] vat idle=${clips.idle.frameStart}+${clips.idle.frameCount} move=${clips.move.frameStart}+${clips.move.frameCount} board=${clips.board.frameStart}+${clips.board.frameCount}`);
        this.reset('enter');
        this.scheduleOnce(() => this.reportTapCenters(), 0.15);
    }

    private createScene(
        poses: ScenePoses, background: Prefab, parking: Prefab, backdropMaterial: Material, spotMaterial: Material,
        levelOne: LevelOneScene, vipMark: Prefab, vipMaterial: Material, seatBadge: Prefab,
    ): void {
        const cameraBasis = new Node('GameScene Main Camera_2 basis');
        cameraBasis.parent = this.root;
        originalPose(cameraBasis, poses.camera);
        const cameraNode = new Node('GameScene Main Camera_2');
        cameraNode.parent = cameraBasis;
        const radiansPerDegree = Math.PI / 180;
        const halfView = Math.tan(stageFov * radiansPerDegree / 2);
        const framing = (offset: number) => Math.atan(2 * offset * halfView / referenceHeight) / radiansPerDegree;
        const unityForward = Quat.fromEuler(new Quat(), 0, 180, 0);
        const referenceRotation = Quat.fromEuler(new Quat(), framing(referenceOffset.y), framing(referenceOffset.x), 0);
        cameraNode.setRotation(Quat.multiply(new Quat(), unityForward, referenceRotation));
        this.camera = cameraNode.addComponent(Camera);
        this.camera.priority = 0;
        this.camera.visibility = Layers.Enum.DEFAULT;
        this.camera.projection = Camera.ProjectionType.PERSPECTIVE;
        this.camera.fov = stageFov;
        this.camera.near = 100;
        this.camera.far = 116;
        this.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        this.camera.clearColor = new Color(34, 54, 72, 255);

        const sky = this.model(background, cameraBasis, backdropMaterial);
        originalPose(sky, poses.backdrop);
        const light = new Node('Display light');
        light.parent = this.root;
        light.setRotationFromEuler(-45, -35, 0);
        light.addComponent(DirectionalLight).illuminance = 36000;

        this.ground = new Node('Plane_onlyshadow basis');
        this.ground.parent = this.root;
        originalPose(this.ground, poses.ground);
        const parkingRoot = new Node('ParkingSpots');
        parkingRoot.parent = this.ground;
        originalPose(parkingRoot, poses.parking);
        const [vipPose, ...spots] = levelOne.parking;
        const vip = new Node(vipPose.name);
        vip.parent = parkingRoot;
        originalPose(vip, vipPose);
        const base = this.model(parking, vip, vipMaterial);
        originalPose(base, levelOne.vipBase);
        originalPose(this.model(vipMark, base, vipMaterial), levelOne.vipMark);

        spots.forEach((pose, index) => {
            const bay = this.model(parking, parkingRoot, spotMaterial);
            bay.name = pose.name;
            originalPose(bay, pose);
            if (index >= levelOneBayCount) {
                this.adSlots.push(bay);
                return;
            }
            const badge = this.model(seatBadge, bay, this.seatMaterials.teal);
            originalPose(badge, seatBadgePose);
            const badgeLabel = this.label(String(levelOneSeats), 0, 17);
            badgeLabel.color = Color.WHITE;
            badgeLabel.enableOutline = true;
            badgeLabel.outlineColor = new Color(39, 61, 75, 255);
            badgeLabel.outlineWidth = 1;
            const stop = Vec3.transformMat4(new Vec3(), boardingStop, bay.worldMatrix);
            this.bays.push({
                boardingPoint: this.ground.inverseTransformPoint(new Vec3(), stop),
                position: Vec3.add(new Vec3(), parkingRoot.position, bay.position),
                rotation: bay.rotation.clone(), badge, badgeLabel,
            });
        });
    }

    private createConveyor(levelOne: Pick<LevelOneScene, 'conveyor' | 'queue'>, roadMaterial: Material, split?: number): void {
        const { conveyor, queue } = levelOne;
        if (this.conveyorRoot) {
            this.conveyorRoot.active = false;
            this.conveyorRoot.destroy();
            this.conveyorMesh?.destroy();
        }
        const root = new Node(split === undefined ? 'ConveyorBelt1' : 'ConveyorBelt2');
        this.conveyorRoot = root;
        root.parent = this.ground;
        originalPose(root, conveyor.root);
        const road = new Node('Loop_01_0');
        road.parent = root;
        originalPose(road, conveyor.sprite);
        const [left, bottom, right, top] = conveyor.bounds;
        this.conveyorMesh = utils.MeshUtils.createMesh({
            positions: [-left, bottom, 0, -right, bottom, 0, -left, top, 0, -right, top, 0],
            uvs: [0, 1, 1, 1, 0, 0, 1, 0],
            indices: [0, 1, 2, 2, 1, 3],
        });
        const renderer = road.addComponent(MeshRenderer);
        renderer.mesh = this.conveyorMesh;
        renderer.setSharedMaterial(roadMaterial, 0);

        this.conveyor = new PassengerConveyor(this.ground, queue, this.round.queue.length, split);
        log('[OwnedGameplay] conveyor samples entry=' + queue.entry.length + ' ring=' + queue.ring.length);
    }

    private readonly setConveyorMotion = (index: number, moving: boolean): void => {
        const mesh = (moving ? this.moving : this.idle)!.mesh;
        const renderer = this.riderRenderers[index];
        if (renderer.mesh !== mesh) renderer.mesh = mesh;
    };

    private model(prefab: Prefab, parent: Node, material: Material): Node {
        const root = instantiate(prefab);
        root.parent = parent;
        root.getComponentsInChildren(MeshRenderer).forEach((renderer) => renderer.setSharedMaterial(material, 0));
        return root;
    }

    private shadowMaterial(texture: Texture2D, alpha: number): Material {
        const material = originalTextureMaterial(texture, true);
        material.setProperty('mainColor', new Vec4(1, 1, 1, alpha));
        return material;
    }

    private badgeMaterial(texture: Texture2D, color: Vec4): Material {
        const material = originalTextureMaterial(texture, true);
        material.setProperty('mainColor', color);
        return material;
    }

    private setSeatBadge(slot: number, route: BusRoute, remaining: number, entering = false): void {
        const { badge, badgeLabel } = this.bays[slot];
        if (entering) {
            badge.getComponentInChildren(MeshRenderer)!.setSharedMaterial(this.seatMaterials[route], 0);
            const screen = view.getFrameSize();
            const scale = this.getComponent(UITransform)!.width / screen.width;
            const point = this.camera.worldToScreen(badge.worldPosition);
            badgeLabel.node.setPosition((point.x - screen.width / 2) * scale, (point.y - screen.height / 2) * scale, 0);
        }
        badgeLabel.string = String(remaining);
        badge.active = badgeLabel.node.active = remaining > 0;
    }

    private onTouch(event: EventTouch): void {
        if (!this.ready || this.transitioning || (!this.tutorialComplete && this.guideClock < guideStart) || this.paused || this.round.outcome !== 'playing') return;
        const { x, y } = event.getLocation();
        const ray = this.camera.screenPointToRay(x, y);
        let best: StagedVehicle | undefined;
        let nearest = Infinity;
        const endpoint = Vec3.add(new Vec3(), ray.o, ray.d);
        const localRay = new geometry.Ray();
        for (const vehicle of this.level.fleet) {
            if (!this.round.ready.has(vehicle.id)) continue;
            const car = this.cars.get(vehicle.id)!;
            car.inverseTransformPoint(localRay.o, ray.o);
            car.inverseTransformPoint(localRay.d, endpoint);
            localRay.d.subtract(localRay.o);
            const shape = this.bodyArt.get(vehicle.groups ?? 10)!.shape;
            const bounds = vehicle.groups && vehicle.groups !== 10 ? new geometry.AABB(
                ...shape.boxCenter, shape.boxSize[0] / 2, shape.boxSize[1] / 2, shape.boxSize[2] / 2) : vehicleBounds;
            const distance = geometry.intersect.rayAABB(localRay, bounds);
            if (distance > 0 && distance < nearest) {
                best = vehicle;
                nearest = distance;
            }
        }
        if (best) this.dispatch(best);
    }

    private footprint(vehicle: StagedVehicle): VehicleFootprint {
        const shape = this.bodyArt.get(vehicle.groups ?? 10)!.shape;
        const factor = this.level.stagingMultiplier ?? 1.29;
        return { width: shape.boxSize[0] * shape.scale[0] * factor,
            length: shape.boxSize[2] * shape.scale[2] * factor, centerZ: shape.boxCenter[2] * shape.scale[2] * factor };
    }

    private dispatch(vehicle: StagedVehicle): void {
        if (!this.tutorialComplete && this.nextGuideVehicle()?.id !== vehicle.id) {
            log('[OwnedGameplay] guide-blocked ' + vehicle.id);
            return;
        }
        if (this.contacting.has(vehicle.id) || this.round.bays.indexOf(null) < 0) return;
        const car = this.cars.get(vehicle.id)!;
        const footprint = this.footprint(vehicle);
        let obstruction: { id: string; gap: number } | undefined;
        for (const other of this.level.fleet) {
            if (other === vehicle || !this.round.ready.has(other.id)) continue;
            const gap = distanceToBlocker(vehicle, footprint, other, this.footprint(other));
            if (gap < (obstruction?.gap ?? Infinity)) obstruction = { id: other.id, gap };
        }
        if (obstruction) {
            this.contacting.add(vehicle.id);
            const heading = Vec3.transformQuat(new Vec3(), Vec3.UNIT_Z, car.rotation);
            const origin = vehicle.position;
            const contact = origin.clone().add(heading.multiplyScalar(obstruction.gap));
            tween(car).to(0.14, { position: contact }, { easing: 'quadOut' })
                .call(() => log(`[OwnedGameplay] contact ${vehicle.id} ${obstruction.id} gap=${obstruction.gap.toFixed(3)}`))
                .to(0.19, { position: origin.clone() }, { easing: 'smooth' })
                .call(() => {
                    this.contacting.delete(vehicle.id);
                    log(`[OwnedGameplay] returned ${vehicle.id}`);
                    this.report('contact-return', vehicle.id);
                }).start();
            return;
        }
        const slot = this.round.dispatch(vehicle);
        if (slot < 0) return;
        this.report('dispatch', vehicle.id);
        const bay = this.bays[slot];
        tween(car).to(this.level.driveInSeconds, { scale: new Vec3(...this.bodyArt.get(vehicle.groups ?? 10)!.shape.scale) }, { easing: 'smooth' }).start();
        this.vehicleDrive!.enter(car, bay.position, bay.rotation, this.level.driveInSeconds, () => {
            this.vehicleModels.get(vehicle.id)!.arrow.active = false;
            const belt = this.conveyor!;
            this.round.park(slot);
            const arrivalCells = [...belt.exitCells].sort((a, b) => belt.distanceToExitEnd(a) - belt.distanceToExitEnd(b));
            for (const cell of arrivalCells) {
                const rider = belt.passengerAt(cell);
                if (rider >= 0 && this.round.canReserve(slot, this.round.queue[rider])) {
                    this.round.reserve(slot, belt.reserveGroup(cell), true);
                    log(`[OwnedGameplay] arrival-reservation ${vehicle.id} rider=${rider} slot=${slot}`);
                }
            }
            this.setSeatBadge(slot, vehicle.route, vehicleSeats(vehicle), true);
            this.report('parked', vehicle.id);
            this.playAvailableBoarding();
        });
    }

    private playAvailableBoarding(): void {
        if (this.resultShown) return;
        const belt = this.conveyor!;
        if (this.round.needsFailureCheck && this.introReady && belt.canCheckFailure(this.riders.length)) {
            this.round.checkFailure(belt.occupiedCells);
        }
        const outcome = this.round.outcome;
        if (outcome !== 'playing') {
            if (outcome === 'won') {
                this.tutorialComplete = true;
                if (this.level.number < 3) void this.prepareNextLevel().catch(error =>
                    log('[OwnedGameplay] level-prefetch-error ' + String(error)));
            }
            this.resultShown = true;
            this.renderStatus();
            this.report(outcome);
            return;
        }
        for (const cell of belt.exitCells) {
            const rider = belt.passengerAt(cell);
            if (rider < 0) continue;
            const route = this.round.queue[rider];
            const slot = this.round.boardingSlot(route);
            if (slot >= 0) {
                if (this.round.bays.some((_, later) => later > slot && this.round.canReserve(later, route))) {
                    log(`[OwnedGameplay] same-color-choice ${this.round.bays[slot]!.vehicle.id} slot=${slot}`);
                }
                this.round.reserve(slot, belt.reserveGroup(cell), false);
            }
        }
        this.round.bays.forEach((bay, slot) => {
            if (!bay) return;
            for (let i = 0; i < bay.waitingGroups.length; i++) {
                const group = bay.waitingGroups[i];
                if ((group.waitForEarlier && i > 0) || this.boardingClock < group.nextPassengerAt) continue;
                group.waitForEarlier = false;
                const member = group.members.shift()!;
                group.nextPassengerAt = this.boardingClock + passengerInterval;
                belt.leaveForVehicle(member);
                this.movePassengerToSeat(member, slot, bay.vehicle);
                if (!group.members.length) bay.waitingGroups.splice(i--, 1);
            }
        });
    }

    private movePassengerToSeat(index: number, slot: number, vehicle: StagedVehicle): void {
        const rider = this.riders[index];
        const renderer = this.riderRenderers[index];
        renderer.mesh = this.boarding!.mesh;

        log('[OwnedGameplay] animate-board ' + vehicle.id);
        const destination = this.bays[slot].boardingPoint;
        const travelTime = Vec3.distance(rider.position, destination) / boardingSpeed;
        rider.setRotationFromEuler(0,
            Math.atan2(destination.x - rider.position.x, destination.z - rider.position.z) * 180 / Math.PI, 0);
        tween(rider).to(travelTime, { position: destination }).call(() => {
            renderer.mesh = this.idle!.mesh;
            rider.active = false;
            const model = this.vehicleModels.get(vehicle.id)!.bodyAndWheels;
            this.vehicleBoarding?.model.setScale(1, 1, 1);
            model.setScale(1, 1, 1);
            this.vehicleBoarding = { model, elapsed: 0 };
            const remaining = this.round.board(slot);
            this.setSeatBadge(slot, vehicle.route, remaining);
            log(`[OwnedGameplay] boarded ${vehicle.id} count=${this.round.boarded} remaining=${remaining}`);
            if (!remaining) this.depart(slot, vehicle.id);
            this.playAvailableBoarding();
        }).start();
    }

    private depart(slot: number, vehicleId: string): void {
        const car = this.cars.get(vehicleId)!;
        const stillInPlay = this.round.ready.size + this.round.bays.filter(bay => bay && bay.stage !== 'leaving').length;
        this.conveyor!.boostForRemainingVehicles(stillInPlay);
        // StateOutStation.OnEnter releases the ParkingSpot before the car drives away.
        this.round.vacate(slot);
        this.report('vacated', vehicleId);
        this.vehicleDrive!.exit(car, () => {
            car.active = false;
            this.round.depart(vehicleId);
            this.report('departed', vehicleId);
            this.playAvailableBoarding();
        });
    }

    private prepareNextLevel(): Promise<void> {
        if (!this.nextArt) this.nextArt = (this.level === firstLevel ? this.loadNextArt() : this.loadThirdArt()).catch(error => {
            this.nextArt = undefined;
            throw error;
        });
        return this.nextArt;
    }

    private advanceLevel(): boolean {
        if (this.level.number >= 3) return false;
        if (this.transitioning) return true;
        this.transitioning = true;
        void this.prepareNextLevel().then(() => {
            if (isValid(this, true)) this.playTransition();
        }).catch(error => {
            if (!isValid(this, true)) return;
            this.transitioning = false;
            this.resultPanels?.retryContinue();
            log('[OwnedGameplay] level-load-error ' + String(error));
        });
        return true;
    }

    private playTransition(): void {
        const canvas = this.node.getComponent(UITransform)!;
        const screen = view.getFrameSize();
        const height = canvas.width * screen.height / screen.width;
        this.sky.getComponent(UITransform)!.setContentSize(canvas.width, height + 2);
        this.sky.setPosition(0, height, 0);
        this.sky.setSiblingIndex(this.node.children.length - 1);
        this.sky.active = true;
        this.plane.getComponent(UITransform)!.setContentSize(canvas.width * 0.63, canvas.width * 0.42);
        this.plane.getComponent(UITransform)!.setAnchorPoint(0.83, 0.80);
        this.plane.setPosition(-canvas.width * 0.18, height * 0.35, 0);
        tween(this.plane).to(2.2, {position: new Vec3(canvas.width * 0.52, height * 0.58, 0)}).start();
        log(`[OwnedGameplay] sky-transition ${this.level.number}->${this.level.number + 1}`);
        tween(this.sky).to(1.0, { position: new Vec3(0, 0, 0) }, { easing: 'quadOut' })
            .call(() => {
                this.stopMoves();
                for (const actor of this.cars.values()) {
                    actor.active = false;
                    actor.destroy();
                }
                this.cars.clear();
                this.vehicleModels.clear();
                this.level = this.level === firstLevel ? levelTwo : this.thirdBoard!;
                this.nextArt = undefined;
                if (this.level === levelTwo) this.showAdMarks();
                this.reset('next-level');
            }).delay(0.60).to(0.60, { position: new Vec3(0, -height, 0) }, { easing: 'quadIn' })
            .call(() => {
                this.sky.active = false;
                this.transitioning = false;
                this.reportTapCenters();
                log('[OwnedGameplay] level-playable ' + this.level.number);
            }).start();
    }

    private reset(event: 'enter' | 'restart' | 'next-level'): void {
        if (!this.ready || (this.transitioning && event !== 'next-level')) return;
        this.stopMoves();
        this.round = new LevelOneDispatch(this.level);
        if (event === 'next-level') {
            if (this.level.number === 3) this.switchConveyor();
            this.buildActors();
        }
        this.paused = false;
        this.introReady = false;
        this.guideClock = 0;
        this.vehicleBoarding = undefined;
        this.boardingClock = 0;
        this.resultShown = false;
        this.boarding?.reset();
        this.idle?.reset();
        this.moving?.reset();
        this.level.fleet.forEach((vehicle) => {
            const car = this.cars.get(vehicle.id)!;
            car.active = true;
            car.setScale(new Vec3(...this.bodyArt.get(vehicle.groups ?? 10)!.shape.scale).multiplyScalar(this.level.stagingMultiplier ?? 1.29));
            car.setPosition(vehicle.position);
            car.setRotationFromEuler(0, vehicle.yaw, 0);
            const { bodyAndWheels, arrow } = this.vehicleModels.get(vehicle.id)!;
            bodyAndWheels.setScale(1, 1, 1);
            arrow.active = true;
        });
        this.conveyor!.reset(this.riders, this.level.entrySeconds, this.level.fillSeconds, this.level.settleRate);
        this.bays.forEach(({ badge, badgeLabel }) => {
            badge.active = badgeLabel.node.active = false;
        });
        this.renderStatus();
        this.updateGuide(0);
        this.report(event);
    }

    private stopMoves(): void {
        this.contacting.clear();
        this.cars.forEach((node) => Tween.stopAllByTarget(node));
        this.riders.forEach((node) => Tween.stopAllByTarget(node));
        this.vehicleDrive?.reset();
    }

    private createOnboardingHud(
        hand: Texture2D, circle: Texture2D, pause: Texture2D, propButton: Texture2D, padlock: Texture2D,
        lockBody: Texture2D, tutorialPanel: Texture2D,
    ): void {
        this.pauseNode = this.makeImage('Original pause icon', pause);
        this.positionHud(this.pauseNode, { anchor: [1, 1], position: [-67, -80], size: [110, 118] });
        this.pauseNode.on(Node.EventType.TOUCH_END, () => this.togglePause());

        [4, 8, 13].forEach((level, index) => {
            const x = 350 * (index - 1);
            const button = this.makeImage('Locked prop ' + level, propButton);
            const lock = this.makeImage('Original padlock ' + level, padlock);
            const body = this.makeImage('Original padlock body ' + level, lockBody);
            const levelLabel = this.label('Level ' + level, 0, 18);
            levelLabel.color = Color.WHITE;
            levelLabel.enableOutline = true;
            levelLabel.outlineColor = new Color(63, 80, 97, 255);
            levelLabel.outlineWidth = 2;
            this.positionHud(button, { anchor: [0.5, 0], position: [x, 160], size: [250, 170] });
            this.positionHud(lock, { anchor: [0.5, 0], position: [x, 215], size: [60, 80] });
            this.positionHud(body, { anchor: [0.5, 0], position: [x, 179], size: [90, 90] });
            this.positionHud(levelLabel.node, { anchor: [0.5, 0], position: [x, 143], size: [245, 48] });
            this.propNodes.push(button, lock, body, levelLabel.node);
        });

        this.guideCircle = this.makeImage('Tap marker', circle);
        this.guideHand = this.makeImage('Original tutorial hand', hand);
        this.positionHud(this.guideCircle, { anchor: [0.5, 0.5], position: [0, 0], size: [102, 102] });
        this.positionHud(this.guideHand, { anchor: [0.5, 0.5], position: [0, 0], size: [724, 746] });
        this.guideCard = this.makeImage('Original first-dispatch tutorial', tutorialPanel);
        const panel = this.guideCard.getComponent(Sprite)!;
        const frame = panel.spriteFrame!;
        [frame.insetLeft, frame.insetBottom, frame.insetRight, frame.insetTop] = [63, 66, 61, 55];
        panel.type = Sprite.Type.SLICED;
        this.positionHud(this.guideCard, { anchor: [0.5, 0.22], position: [0, 0], size: [970, 225] });
        this.guideCaption = this.label('Tap the vehicle to\nmatch the passengers', 0, 50);
        this.guideCaption.color = new Color(113, 72, 31);
        this.guideCaption.isBold = true;
        this.guideCaption.overflow = Label.Overflow.SHRINK;
        this.positionHud(this.guideCaption.node, { anchor: [0.5, 0.22], position: [0, 7], size: [870, 175] });
    }

    private nextGuideVehicle(): StagedVehicle | undefined {
        return this.level.fleet.find((vehicle) => this.round.ready.has(vehicle.id));
    }

    private updateGuide(dt: number): void {
        this.guideClock += dt;
        const next = this.nextGuideVehicle();
        const show = !this.tutorialComplete && this.guideClock >= guideStart && !this.paused && this.round.outcome === 'playing' && !!next;
        this.vehicleModels.forEach(({ outline }, id) => { outline.active = show && id === next?.id; });
        this.guideHand!.active = show;
        this.guideCircle!.active = show;
        this.guideCaption!.node.active = show && this.round.ready.size === this.level.fleet.length;
        if (!this.guideCard!.active && this.guideCaption!.node.active) log('[OwnedGameplay] first-guide-visible');
        this.guideCard!.active = this.guideCaption!.node.active;
        if (!show || !next) return;
        const camera = this.camera;
        const point = camera.worldToScreen(this.cars.get(next.id)!.worldPosition.clone().add3f(0, 0.14, 0));
        const screen = view.getFrameSize();
        const factor = this.getComponent(UITransform)!.width / screen.width;
        const x = point.x - screen.width * 0.5;
        const y = point.y - screen.height * 0.5;
        const pulse = Math.sin(this.guideClock * 7);
        this.guideCircle!.setPosition(x * factor, y * factor, 0);
        this.guideCircle!.setScale(1 + pulse * 0.13, 1 + pulse * 0.13, 1);
        const hudUnit = this.getComponent(UITransform)!.width / 1080;
        this.guideHand!.setPosition(x * factor + (210 + pulse * 10) * hudUnit,
            y * factor - (250 + pulse * 10) * hudUnit, 0);
    }

    private togglePause(): void {
        if (!this.ready || this.transitioning || this.round.outcome !== 'playing') return;
        this.paused = !this.paused;
        const control = this.paused ? Tween.pauseAllByTarget : Tween.resumeAllByTarget;
        this.cars.forEach((car) => control(car));
        this.riders.forEach((rider) => control(rider));
        this.updateGuide(0);
        this.status.string = 'Paused · Tap pause to resume';
        this.status.node.active = this.paused;
        log(this.paused ? '[OwnedGameplay] pause' : '[OwnedGameplay] resume');
    }

    private renderStatus(): void {
        const outcome = this.round.outcome;
        const showHud = outcome !== 'lost';
        this.levelTitle!.active = showHud && this.level.number === 1;
        if (this.nextTitle) this.nextTitle.active = showHud && this.level.number === 2;
        if (this.thirdTitle) this.thirdTitle.active = showHud && this.level.number === 3;
        this.pauseNode!.active = showHud;
        this.propNodes.forEach((node) => { node.active = showHud; });
        this.status.node.active = false;
        const replayPosition = this.resultPanels?.show(outcome, this.level.number);
        this.replayNode!.active = outcome !== 'won';
        if (replayPosition) {
            this.replayNode!.setPosition(...replayPosition, 0);
            this.replayNode!.getComponent(UITransform)!.setContentSize(62, 67);
        } else {
            this.positionHud(this.replayNode!, this.hud!.replay);
        }
    }

    private positionHud(node: Node, placement: HudPlacement): void {
        const canvas = this.getComponent(UITransform)!.contentSize;
        const screen = view.getFrameSize();
        const height = screen.width ? canvas.width * screen.height / screen.width : canvas.height;
        const scale = canvas.width / 1080;
        node.setPosition(
            (placement.anchor[0] - 0.5) * canvas.width + placement.position[0] * scale,
            (placement.anchor[1] - 0.5) * height + placement.position[1] * scale,
            0,
        );
        node.getComponent(UITransform)!.setContentSize(placement.size[0] * scale, placement.size[1] * scale);
    }

    private makeImage(name: string, texture: Texture2D): Node {
        const node = new Node(name);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        const frame = new SpriteFrame();
        frame.texture = texture;
        sprite.spriteFrame = frame;
        return node;
    }

    private label(text: string, y: number, size: number): Label {
        const node = new Node(text);
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(0, y, 0);
        node.addComponent(UITransform).setContentSize(480, size + 12);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 4;
        label.color = new Color(34, 49, 54);
        return label;
    }

    private report(event: string, vehicle?: string): void {
        log('[OwnedGameplay] ' + JSON.stringify({
            event, vehicle, level: this.level.number, boarded: this.round.boarded, outcome: this.round.outcome,
            ready: Array.from(this.round.ready), bays: this.round.bays.flatMap((bay, slot) => bay ? [{
                slot, id: bay.vehicle.id, seatsLeft: bay.seatsLeft, stage: bay.stage,
            }] : []),
        }));
    }

    private reportTapCenters(): void {
        const screen = view.getFrameSize();
        const values = this.level.fleet.map(({ id }) => {
            const car = this.cars.get(id)!;
            const center = car.worldPosition.clone().add3f(0, 0.14, 0);
            const point = this.camera.worldToScreen(center);
            return { id, x: Math.round(point.x), y: Math.round(screen.height - point.y) };
        });
        log('[OwnedGameplay] tap-centers ' + JSON.stringify({ size: [screen.width, screen.height], values }));
    }
}
