import {
    Color, Graphics, JsonAsset, Label, log, Node, sp, Sprite, SpriteFrame, Texture2D,
    Tween, tween, UITransform, Vec3, view,
} from 'cc';
import type { Outcome } from './DispatchRound';
import { loadOwnedArt } from './OwnedArtAssets';

type Result = Exclude<Outcome, 'playing'>;

interface Layer {
    texture: string;
    position: [number, number];
    size: [number, number];
    slice: [number, number, number, number] | null;
    tint?: [number, number, number, number];
}

interface Panel {
    maskAlpha: number;
    maskSizeDelta: [number, number];
    replayPosition: [number, number];
    layers: Layer[];
}

interface PanelLayout {
    won: Panel & {
        victory: {
            character: { position: [number, number]; scale: number };
            rewardPosition: [number, number];
            button: {
                position: [number, number];
                size: [number, number];
                labelPosition: [number, number];
                label: string;
                layers: Layer[];
            };
        };
    };
    lost: Panel & { titlePosition: [number, number] };
}

interface ResultArt {
    layout: PanelLayout;
    textures: ReadonlyMap<string, Texture2D>;
    victorySkeleton: sp.SkeletonData;
}

const sourceWidth = 1080;
const firstLevelReward = 20;
const coinTexture = 'victory-balance-coin';

export async function loadResultArt(): Promise<ResultArt> {
    const asset = await loadOwnedArt('result-panel-layout', JsonAsset);
    const layout = asset.json as unknown as PanelLayout;
    const layers = [...layout.won.layers, ...layout.lost.layers, ...layout.won.victory.button.layers];
    const names = [...layers.map(({ texture }) => texture), coinTexture];
    const [entries, victorySkeleton] = await Promise.all([
        Promise.all(names.map(async (name) => [
            name, await loadOwnedArt(name + '/texture', Texture2D),
        ] as const)),
        loadOwnedArt('victory-spine/victory', sp.SkeletonData),
    ]);
    return { layout, textures: new Map(entries), victorySkeleton };
}

export class OwnedResultPanels {
    private readonly root: Node;
    private readonly mask: Graphics;
    private readonly panels: Record<Result, Node>;
    private readonly character: sp.Skeleton;
    private readonly action: Node;
    private readonly actionLabel: Label;
    private readonly wallet: Node;
    private readonly balanceLabel: Label;
    private readonly flyingCoin: Node;
    private readonly completeLabel: Label;
    private outcome: Outcome = 'playing';
    private rewardState: 'offered' | 'collecting' | 'collected' = 'offered';
    private balance = 100;

    constructor(private readonly parent: Node, private readonly art: ResultArt, onReplay: () => void) {
        this.root = this.child('Original result panels', parent);
        this.root.active = false;
        const mask = this.child('Result mask', this.root);
        mask.addComponent(UITransform);
        this.mask = mask.addComponent(Graphics);
        this.panels = {
            won: this.makePanel('won'),
            lost: this.makePanel('lost'),
        };
        const source = art.layout.won.victory;
        const character = this.child('Original victory Spine', this.panels.won);
        character.setSiblingIndex(0);
        character.setPosition(...source.character.position, 0);
        character.setScale(source.character.scale, source.character.scale, 1);
        this.character = character.addComponent(sp.Skeleton);
        this.character.skeletonData = art.victorySkeleton;
        this.character.premultipliedAlpha = true;
        this.character.setStartListener((entry) => {
            if (entry?.animation?.name === 'idle') log('[OwnedGameplay] victory-spine idle');
        });
        this.caption(this.panels.won, 'Victory reward', '' + firstLevelReward, source.rewardPosition,
            [400, 118], 66, new Color(255, 207, 49), new Color(99, 52, 5));

        this.action = this.child('Continue or replay', this.root);
        this.action.addComponent(UITransform).setContentSize(...source.button.size);
        const relative = ([x, y]: [number, number]): [number, number] => [
            x - source.button.position[0], y - source.button.position[1],
        ];
        for (const layer of source.button.layers) {
            this.image(this.action, { ...layer, position: relative(layer.position) });
        }
        this.actionLabel = this.caption(this.action, 'Continue text', source.button.label,
            relative(source.button.labelPosition), [400, 142], 79, Color.WHITE, new Color(143, 57, 9));
        this.action.on(Node.EventType.TOUCH_END, () => {
            if (this.rewardState === 'collected') onReplay();
            else this.collectReward();
        });

        this.completeLabel = this.caption(this.root, 'Completed first level', 'Level 1 complete', [0, 0],
            [760, 144], 76, new Color(38, 59, 74));
        this.wallet = this.child('Victory coin balance', this.root);
        const capsule = this.wallet.addComponent(Graphics);
        capsule.fillColor = new Color(250, 253, 255);
        capsule.roundRect(-116, -31, 232, 62, 31);
        capsule.fill();
        this.image(this.wallet, { texture: coinTexture, position: [-92, 0], size: [76, 79], slice: null });
        this.balanceLabel = this.caption(this.wallet, 'Coin balance value', '' + this.balance,
            [25, 0], [168, 68], 45, new Color(29, 63, 97));
        this.flyingCoin = this.image(this.root, { texture: coinTexture, position: [0, 0], size: [90, 94], slice: null });
    }

    show(outcome: Outcome): [number, number] | null {
        this.outcome = outcome;
        this.rewardState = 'offered';
        Tween.stopAllByTarget(this.flyingCoin);
        this.flyingCoin.active = false;
        this.completeLabel.node.active = false;
        this.action.active = this.wallet.active = outcome === 'won';
        this.panels.won.active = outcome === 'won';
        this.panels.lost.active = outcome === 'lost';
        this.root.active = outcome !== 'playing';
        if (outcome === 'playing') {
            this.character.clearTracks();
            return null;
        }

        const size = this.parent.getComponent(UITransform)!.contentSize;
        const scale = size.width / sourceWidth;
        this.mask.clear();
        this.mask.enabled = true;
        const { maskAlpha: alpha, maskSizeDelta, replayPosition } = this.art.layout[outcome];
        if (alpha > 0) {
            const width = size.width + scale * maskSizeDelta[0];
            const height = size.height + scale * maskSizeDelta[1];
            this.mask.fillColor = new Color(0, 0, 0, Math.round(alpha * 255));
            this.mask.rect(-width / 2, -height / 2, width, height);
            this.mask.fill();
        }

        this.panels[outcome].setScale(scale, scale, 1);
        if (outcome === 'won') {
            const screen = view.getFrameSize();
            const height = screen.width ? scale * sourceWidth * screen.height / screen.width : size.height;
            const { button } = this.art.layout.won.victory;
            this.action.setScale(scale, scale, 1);
            this.action.setPosition(button.position[0] * scale, button.position[1] * scale, 0);
            this.actionLabel.string = button.label;
            this.wallet.setScale(scale, scale, 1);
            this.wallet.setPosition(-size.width / 2 + 180 * scale, height / 2 - 80 * scale, 0);
            this.completeLabel.node.setScale(scale, scale, 1);
            this.character.clearTracks();
            const jump = this.character.setAnimation(0, 'jump', false);
            const idle = this.character.addAnimation(0, 'idle', true, 0);
            if (jump && idle) log('[OwnedGameplay] victory-spine jump queued-idle');
            return null;
        }
        return [replayPosition[0] * scale, replayPosition[1] * scale];
    }

    private collectReward(): void {
        if (this.outcome !== 'won' || this.rewardState !== 'offered') return;
        this.rewardState = 'collecting';
        this.panels.won.active = false;
        this.action.active = false;
        this.mask.enabled = false;
        const scale = this.wallet.scale.x;
        const arrival = this.wallet.position.clone().add3f(-92 * scale, 0, 0);
        this.flyingCoin.setPosition(0, 90 * scale, 0);
        this.flyingCoin.setScale(scale, scale, 1);
        this.flyingCoin.active = true;
        tween(this.flyingCoin).to(0.17, { position: new Vec3(20 * scale, 150 * scale, 0) }, { easing: 'quadOut' })
            .to(0.47, { position: arrival }, { easing: 'quadIn' }).call(() => {
                this.flyingCoin.active = false;
                this.balance += firstLevelReward;
                this.balanceLabel.string = '' + this.balance;
                this.rewardState = 'collected';
                this.completeLabel.node.active = true;
                this.actionLabel.string = 'Replay';
                this.action.active = true;
                log('[OwnedGameplay] victory-reward ' + JSON.stringify({ amount: firstLevelReward, balance: this.balance }));
            }).start();
    }

    destroy(): void {
        Tween.stopAllByTarget(this.flyingCoin);
    }

    private makePanel(result: Result): Node {
        const panel = this.child(result === 'won' ? 'Victory art' : 'Failure art', this.root);
        for (const layer of this.art.layout[result].layers) {
            this.image(panel, layer);
        }
        if (result === 'lost') {
            const node = this.child('Failure title', panel);
            node.setPosition(...this.art.layout.lost.titlePosition, 0);
            node.addComponent(UITransform).setContentSize(700, 152);
            const label = node.addComponent(Label);
            label.string = 'Depot blocked';
            label.fontSize = 70;
            label.lineHeight = 84;
            label.color = new Color(74, 41, 14);
        }
        return panel;
    }

    private image(parent: Node, layer: Layer): Node {
        const node = this.child(layer.texture, parent);
        node.setPosition(...layer.position, 0);
        const transform = node.addComponent(UITransform);
        const sprite = node.addComponent(Sprite);
        const frame = new SpriteFrame();
        frame.texture = this.art.textures.get(layer.texture)!;
        if (layer.slice) {
            [frame.insetLeft, frame.insetBottom, frame.insetRight, frame.insetTop] = layer.slice;
            sprite.type = Sprite.Type.SLICED;
        }
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = frame;
        if (layer.tint) sprite.color = new Color(...layer.tint);
        transform.setContentSize(...layer.size);
        return node;
    }

    private caption(parent: Node, name: string, text: string, position: [number, number], size: [number, number],
        fontSize: number, color: Color, outline?: Color,
    ): Label {
        const node = this.child(name, parent);
        node.setPosition(...position, 0);
        node.addComponent(UITransform).setContentSize(...size);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = fontSize;
        label.lineHeight = fontSize + 8;
        label.color = color;
        label.overflow = Label.Overflow.SHRINK;
        if (outline) {
            label.enableOutline = true;
            label.outlineColor = outline;
            label.outlineWidth = 4;
        }
        return label;
    }

    private child(name: string, parent: Node): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        return node;
    }
}
