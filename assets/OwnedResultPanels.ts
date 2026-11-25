import {
    BlockInputEvents, Color, Graphics, JsonAsset, Label, log, Node, sp, Sprite, SpriteFrame, Texture2D,
    UITransform, UIOpacity, view,
} from 'cc';
import type { Outcome } from './DispatchRound';
import { loadOwnedArt } from './OwnedArtAssets';
import { VictoryEffects, VictoryMotion } from './VictoryEffects';

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

export interface RatingLayout {
    labels: Record<'Title_Text' | 'Content_Text', {text: string; x: number; y: number; width: number; height: number; font: number}>;
    buttons: Record<'Btn_Close' | 'Btn_Yellow' | 'Btn_Green', [number, number, number, number]>;
}

interface ResultArt {
    layout: PanelLayout;
    textures: ReadonlyMap<string, Texture2D>;
    victorySkeleton: sp.SkeletonData;
    motion: VictoryMotion;
}

const sourceWidth = 1080;
const firstLevelReward = 20;
// At the first visible mask frame the reference title has reached the end of its pop-in.
const victoryClipAtReveal = 0.23;
const coinTexture = 'victory-balance-coin';

export async function loadResultArt(): Promise<ResultArt> {
    const asset = await loadOwnedArt('result-panel-layout', JsonAsset);
    const layout = asset.json as unknown as PanelLayout;
    const layers = [...layout.won.layers, ...layout.lost.layers, ...layout.won.victory.button.layers];
    const motion = (await loadOwnedArt('victory-motion', JsonAsset)).json as unknown as VictoryMotion;
    const reward = layout.won.layers.find(layer => layer.texture === 'victory-coins');
    if (reward) {
        reward.texture = 'victory-small-reward';
        reward.position = [0, -90];
        reward.size = motion.rewardSize;
    }
    const names = [...new Set([...layers.map(({ texture }) => texture), coinTexture, 'victory-fireworks', 'victory-coin-spin', 'victory-coin-glint'])];
    const [entries, victorySkeleton] = await Promise.all([
        Promise.all(names.map(async (name) => [
            name, await loadOwnedArt(name + '/texture', Texture2D),
        ] as const)),
        loadOwnedArt('victory-spine/victory', sp.SkeletonData),
    ]);
    return { layout, textures: new Map(entries), victorySkeleton, motion };
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
    private readonly effects: VictoryEffects;
    private readonly maskOpacity: UIOpacity;
    private readonly rewardIcon: Node;
    private readonly rewardLabel: Node;
    private readonly title: Node;
    private rating?: Node;
    private ratingShade?: Graphics;
    private ratingSeen = false;
    private elapsed = 0;
    private panelScale = 1;
    private readonly completeLabel: Label;
    private outcome: Outcome = 'playing';
    private rewardState: 'offered' | 'collecting' | 'collected' = 'offered';
    private balance = 100;

    constructor(private readonly parent: Node, private readonly art: ResultArt, onReplay: () => void,
        private readonly onContinue: () => boolean) {
        this.root = this.child('Original result panels', parent);
        this.root.active = false;
        const mask = this.child('Result mask', this.root);
        mask.addComponent(UITransform);
        this.mask = mask.addComponent(Graphics);
        this.maskOpacity = mask.addComponent(UIOpacity);
        this.panels = {
            won: this.makePanel('won'),
            lost: this.makePanel('lost'),
        };
        this.title = this.panels.won.getChildByName('victory-title')!;
        this.title.setPosition(this.title.position.x, this.title.position.y - 82, 0);
        this.rewardIcon = this.panels.won.getChildByName('victory-small-reward')!;
        const source = art.layout.won.victory;
        const character = this.child('Original victory Spine', this.panels.won);
        character.setSiblingIndex(0);
        character.setPosition(source.character.position[0], source.character.position[1] - 82, 0);
        character.setScale(source.character.scale, source.character.scale, 1);
        this.character = character.addComponent(sp.Skeleton);
        this.character.skeletonData = art.victorySkeleton;
        this.character.premultipliedAlpha = true;
        this.character.setStartListener((entry) => {
            if (entry?.animation?.name === 'idle') log('[OwnedGameplay] victory-spine idle');
        });
        const rewardLabel = this.caption(this.panels.won, 'Victory reward', '' + firstLevelReward, [0, -193],
            [400, 118], 66, new Color(255, 207, 49), new Color(99, 52, 5));

        rewardLabel.isBold = true;
        this.rewardLabel = rewardLabel.node;
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
        this.actionLabel.isBold = true;
        this.action.on(Node.EventType.TOUCH_END, () => {
            if (this.rewardState === 'collected') {
                if (this.onContinue()) this.action.active = false;
                else onReplay();
            } else this.collectReward();
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
        this.effects = new VictoryEffects(art.motion, this.panels.won, this.root,
            art.textures.get('victory-fireworks')!, art.textures.get('victory-coin-spin')!, art.textures.get('victory-coin-glint')!);
        this.wallet.setSiblingIndex(this.root.children.length - 1);
    }

    prepareRating(texture: Texture2D, layout: RatingLayout): void {
        const root = this.child('Third level rating', this.root);
        root.addComponent(UITransform);
        root.addComponent(BlockInputEvents);
        const backdrop = this.child('Rating backdrop', root);
        backdrop.addComponent(UITransform);
        this.ratingShade = backdrop.addComponent(Graphics);
        const panel = this.child('LastRateGuidePanel', root);
        const frame = new SpriteFrame();
        frame.texture = texture;
        const sprite = panel.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.spriteFrame = frame;
        panel.getComponent(UITransform)!.setContentSize(900, 1220);
        for (const [key, label] of Object.entries(layout.labels)) {
            const title = key === 'Title_Text';
            const text = label.text.replace(/<[^>]+>/g, '');
            if (!title) {
                const emphasis = label.text.match(/<color=[^>]+>([^<]+)<\/color>(.*)/);
                if (emphasis) {
                    const secondLine = emphasis[1] + emphasis[2];
                    const firstLine = text.slice(0, -secondLine.length).trim();
                    this.caption(panel, key, firstLine, [label.x, label.y + 24], [label.width, 64],
                        label.font, new Color(94, 54, 23)).isBold = true;
                    this.caption(panel, key + ' emphasis', secondLine, [label.x, label.y - 24], [label.width, 64],
                        label.font, new Color(198, 36, 58)).isBold = true;
                    continue;
                }
            }
            const caption = this.caption(panel, key, text, [label.x, label.y],
                [label.width, label.height], label.font, title ? Color.WHITE : new Color(94, 54, 23),
                title ? new Color(145, 89, 21) : undefined);
            caption.isBold = true;
        }
        for (const [choice, [x,y,w,h]] of Object.entries(layout.buttons)) {
            const button = this.child(choice, panel);
            button.addComponent(UITransform).setContentSize(w,h);
            button.setPosition(x,y,0);
            button.on(Node.EventType.TOUCH_END, () => {
                root.active = false;
                this.ratingSeen = true;
                this.action.active = true;
                log('[OwnedGameplay] rating-dismiss ' + choice);
            });
        }
        root.active = false;
        this.rating = root;
    }

    show(outcome: Outcome, level: number): [number, number] | null {
        this.outcome = outcome;
        if (this.rating) this.rating.active = false;
        this.completeLabel.string = 'Level ' + level + ' complete';
        this.rewardState = 'offered';
        this.elapsed = 0;
        this.effects.reset();
        this.maskOpacity.opacity = 255;
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
            this.panelScale = scale * 1.1;
            this.panels.won.setScale(this.panelScale, this.panelScale, 1);
            const { button } = this.art.layout.won.victory;
            this.action.setScale(this.panelScale, this.panelScale, 1);
            this.action.setPosition(button.position[0] * scale, button.position[1] * scale, 0);
            this.actionLabel.string = button.label;
            this.wallet.setScale(scale, scale, 1);
            this.wallet.setPosition(-size.width / 2 + 180 * scale, height / 2 - 80 * scale, 0);
            this.completeLabel.node.setScale(scale, scale, 1);
            this.balanceLabel.string = String(this.balance);
            if (level === 3 && this.rating && !this.ratingSeen) {
                this.rating.active = true;
                this.rating.setScale(this.panelScale, this.panelScale, 1);
                this.rating.getComponent(UITransform)!.setContentSize(size.width / this.panelScale, height / this.panelScale);
                const shade = this.ratingShade!;
                const w = size.width / this.panelScale, h = height / this.panelScale;
                shade.clear();
                shade.fillColor = new Color(0, 0, 0, 210);
                shade.rect(-w/2, -h/2, w, h);
                shade.fill();
                log('[OwnedGameplay] rating-visible');
            }
            this.elapsed = victoryClipAtReveal;
            this.update(0);
            this.character.clearTracks();
            const jump = this.character.setAnimation(0, 'jump', false);
            if (jump) jump.trackTime = 0.12;
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
        this.elapsed = 0;
        this.update(0);
        log('[OwnedGameplay] victory-collection start coins=' + this.art.motion.scatter.length);
    }

    update(dt: number): void {
        if (this.outcome !== 'won' || this.rewardState === 'collected') return;
        this.elapsed += dt;
        if (this.rewardState === 'offered') {
            const motion = this.art.motion;
            const title = this.effects.sample(motion.title, this.elapsed);
            const reward = this.effects.sample(motion.reward, this.elapsed);
            this.title.setScale(title, title, 1);
            this.rewardIcon.setScale(reward, reward, 1);
            this.rewardLabel.active = reward > 0;
            this.rewardLabel.setScale(reward, reward, 1);
            const button = this.art.layout.won.victory.button;
            const offset = this.effects.sample(motion.buttonY, this.elapsed) - motion.buttonY[motion.buttonY.length - 1];
            this.action.active = this.elapsed >= 0.4 && !this.rating?.active;
            this.action.setPosition(button.position[0] * this.panelScale, (button.position[1] + offset) * this.panelScale, 0);
            this.effects.celebrate(this.elapsed);
            return;
        }
        const scale = this.wallet.scale.x;
        this.maskOpacity.opacity = Math.round(255 * Math.max(0, 1 - this.elapsed / 0.33));
        const fraction = this.effects.collect(this.elapsed, scale, this.wallet.position.x - 92 * scale, this.wallet.position.y);
        this.balanceLabel.string = String(this.balance + Math.floor(firstLevelReward * fraction));
        if (fraction < 1) return;
        this.balance += firstLevelReward;
        this.rewardState = 'collected';
        log('[OwnedGameplay] victory-reward ' + JSON.stringify({ amount: firstLevelReward, balance: this.balance }));
        if (this.onContinue()) {
            this.action.active = false;
            return;
        }
        this.completeLabel.node.active = true;
        this.actionLabel.string = 'Replay';
        this.action.active = true;
    }

    retryContinue(): void {
        this.actionLabel.string = 'Retry';
        this.action.active = true;
    }

    destroy(): void {
        this.effects.destroy();
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
