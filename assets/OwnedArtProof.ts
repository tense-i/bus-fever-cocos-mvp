import {
    _decorator, BufferAsset, Camera, Canvas, Color, Component, DirectionalLight,
    instantiate, isValid, JsonAsset, Label, Layers, log, Material, MeshRenderer, Node, profiler,
    Sprite, SpriteFrame, Texture2D, UITransform, Vec3,
} from 'cc';
import {
    loadOwnedArt, loadOwnedModel, originalTextureMaterial, OwnedPassengerPlayback, OwnedPassengerVat,
    passengerMaterial, PassengerClips,
} from './OwnedArtAssets';

const { ccclass } = _decorator;

@ccclass('OwnedArtProof')
export class OwnedArtProof extends Component {
    private world!: Node;
    private idle?: OwnedPassengerPlayback;
    private readonly materials: Material[] = [];
    private status!: Label;

    onLoad(): void {
        profiler.hideStats();
        this.label('Bus Fever Party! assets', 396, 35);
        this.status = this.label('Loading original assets', 345, 25);
        const hudCamera = this.getComponent(Canvas)!.cameraComponent!;
        hudCamera.priority = 1;
        hudCamera.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        this.world = new Node('Original art');
        this.world.parent = this.node.scene;
        const cameraNode = new Node('Art camera');
        cameraNode.parent = this.world;
        cameraNode.setPosition(0, 7, 9);
        cameraNode.lookAt(new Vec3(0, 0.5, 0));
        const camera = cameraNode.addComponent(Camera);
        camera.priority = 0;
        camera.visibility = Layers.Enum.DEFAULT;
        camera.projection = Camera.ProjectionType.ORTHO;
        camera.orthoHeight = 4.2;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(28, 43, 60, 255);
        const light = new Node('Art light');
        light.parent = this.world;
        light.setRotationFromEuler(-40, -35, 0);
        light.addComponent(DirectionalLight).illuminance = 36000;
        void this.loadArt().catch((error: unknown) => {
            if (!isValid(this, true)) return;
            this.status.string = 'Asset load failed';
            console.error('[OwnedArt] ' + (error instanceof Error ? error.stack : String(error)));
        });
    }

    update(dt: number): void {
        this.idle?.advance(dt);
    }

    onDestroy(): void {
        this.world.destroy();
        this.idle?.mesh.destroy();
        this.materials.forEach((material) => material.destroy());
    }

    private async loadArt(): Promise<void> {
        const [body, wheel, passenger, baseMap, replay, textureSamples, clipData] = await Promise.all([
            loadOwnedModel('bus-body'), loadOwnedModel('bus-wheel'), loadOwnedModel('passenger-idle-indexed'),
            loadOwnedArt('bus-base-map/texture', Texture2D), loadOwnedArt('replay-icon/texture', Texture2D),
            loadOwnedArt('passenger-idle-positions', BufferAsset), loadOwnedArt('passenger-clips', JsonAsset),
        ]);
        if (!isValid(this, true)) return;

        const bus = new Node('Original bus');
        bus.parent = this.world;
        bus.setPosition(-0.76, 0, 0.25);
        bus.setRotationFromEuler(0, -25, 0);
        bus.setScale(0.78, 0.78, 0.78);
        const busMaterial = originalTextureMaterial(baseMap);
        this.materials.push(busMaterial);
        for (const prefab of [body, wheel]) {
            const part = instantiate(prefab);
            part.parent = bus;
            part.getComponentsInChildren(MeshRenderer).forEach((renderer) => renderer.setSharedMaterial(busMaterial, 0));
        }

        const rider = instantiate(passenger);
        rider.parent = this.world;
        rider.setPosition(0.87, 0, -0.55);
        rider.setRotationFromEuler(0, -45, 0);
        rider.setScale(0.65, 0.65, 0.65);
        const renderer = rider.getComponentInChildren(MeshRenderer)!;
        const clips = clipData.json as unknown as PassengerClips;
        this.idle = new OwnedPassengerVat(renderer.mesh!, textureSamples.buffer()).play(clips.idle);
        renderer.mesh = this.idle.mesh;
        const riderMaterial = passengerMaterial(new Color(254, 53, 80, 255));
        this.materials.push(riderMaterial);
        renderer.setSharedMaterial(riderMaterial, 0);
        this.makeReplay(replay);
        this.status.string = 'Original mesh and idle animation';
        log('[OwnedArt] ready passenger=471 vatFrames=99 textureBytes=' + textureSamples.buffer().byteLength);
    }

    private makeReplay(texture: Texture2D): void {
        const node = new Node('Original replay icon');
        node.layer = this.node.layer;
        node.parent = this.node;
        node.setPosition(0, -316, 0);
        node.addComponent(UITransform).setContentSize(92, 98);
        const sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        const frame = new SpriteFrame();
        frame.texture = texture;
        sprite.spriteFrame = frame;
        node.on(Node.EventType.TOUCH_END, () => {
            this.idle?.reset();
            log('[OwnedArt] replay frames=99');
        });
        this.label('Replay', -388, 18);
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
        label.color = new Color(242, 244, 252, 255);
        return label;
    }

}
