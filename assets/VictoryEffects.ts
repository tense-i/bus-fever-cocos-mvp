import { Color, Node, Rect, Sprite, SpriteFrame, Texture2D, UITransform } from 'cc';

export interface VictoryMotion {
    fps: number;
    title: number[];
    reward: number[];
    buttonY: number[];
    emitters: [number, number, number, number][];
    scatter: [number, number][];
    rewardSize: [number, number];
    fireworkExtent: number;
    fireworkAnchorY: number;
    fireworkFrames: number;
    glintLife: number;
    glintSpacing: number;
    glintColor: [number, number, number];
}

function atlas(texture: Texture2D, columns: number, rows: number): SpriteFrame[] {
    const width = texture.width / columns;
    const height = texture.height / rows;
    return Array.from({ length: columns * rows }, (_, i) => {
        const frame = new SpriteFrame();
        frame.texture = texture;
        frame.rect = new Rect(i % columns * width, Math.floor(i / columns) * height, width, height);
        return frame;
    });
}

function image(parent: Node, name: string, size: number, initial: SpriteFrame): Sprite {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = initial;
    node.getComponent(UITransform)!.setContentSize(size, size);
    node.active = false;
    return sprite;
}

export class VictoryEffects {
    private readonly sparks: Sprite[];
    private readonly coins: Sprite[];
    private readonly burst: SpriteFrame[];
    private readonly spin: SpriteFrame[];
    private readonly glintFrame: SpriteFrame;
    private readonly glintLayer: Node;
    private readonly glints: Sprite[] = [];
    private visibleGlints = 0;

    constructor(private readonly motion: VictoryMotion, panel: Node, root: Node,
        fireworks: Texture2D, coinSheet: Texture2D, glint: Texture2D) {
        this.burst = atlas(fireworks, 6, 4);
        this.spin = atlas(coinSheet, 4, 4);
        this.sparks = motion.emitters.map(([x, y, scale], index) => {
            const spark = image(panel, 'Victory firework ' + index, motion.fireworkExtent, this.burst[0]);
            spark.node.getComponent(UITransform)!.setAnchorPoint(0.5, motion.fireworkAnchorY);
            spark.node.setPosition(x, y, 0);
            spark.node.setScale(scale, scale, 1);
            return spark;
        });
        this.glintFrame = new SpriteFrame();
        this.glintFrame.texture = glint;
        this.glintLayer = new Node('Coin trails');
        this.glintLayer.layer = root.layer;
        this.glintLayer.parent = root;
        this.coins = motion.scatter.map((_, index) => image(root, 'Victory flying coin ' + index, 142, this.spin[0]));
    }

    sample(track: number[], time: number): number {
        const frame = Math.min(time * this.motion.fps, track.length - 1);
        const index = Math.floor(frame);
        const first = track[index];
        return first + (track[Math.min(index + 1, track.length - 1)] - first) * (frame - index);
    }

    celebrate(time: number): void {
        this.sparks.forEach((spark, i) => {
            const elapsed = time - this.motion.emitters[i][3];
            const frame = Math.floor((elapsed % 2) * this.motion.fps);
            const visible = elapsed >= 0 && frame < this.motion.fireworkFrames;
            spark.node.active = visible;
            if (visible) spark.spriteFrame = this.burst[frame];
        });
    }

    // The authored nine coin offsets animate around the center. Their flight endpoint
    // follows the current wallet so collection also works on narrower portrait screens.
    collect(time: number, scale: number, walletX: number, walletY: number): number {
        let arrived = 0;
        this.visibleGlints = 0;
        this.coins.forEach((coin, i) => {
            const depart = 0.35 + i * 0.056;
            const progress = Math.max(0, Math.min(1, (time - depart) / 0.64));
            coin.node.active = progress < 1;
            const [dx, dy] = this.motion.scatter[i];
            const spread = 1 - Math.pow(1 - Math.min(1, time / 0.27), 2);
            const x = dx * 3.8 * spread * scale;
            const y = (-25 + dy * 3.8 * spread) * scale;
            this.trail(time - depart, progress, scale, x, y, walletX, walletY);
            if (progress === 1) {
                arrived++;
                return;
            }
            const move = progress * progress;
            const lift = Math.sin(progress * Math.PI) * 46 * scale;
            coin.node.setPosition(x + (walletX - x) * move, y + (walletY - y) * move + lift, 0);
            const size = scale * (1 - 0.32 * progress);
            coin.node.setScale(size, size, 1);
            const frame = (i + Math.floor(time * 19.2)) % this.spin.length;
            coin.spriteFrame = this.spin[frame];
        });
        for (let i = this.visibleGlints; i < this.glints.length; i++) this.glints[i].node.active = false;
        if (arrived === this.coins.length) this.glintLayer.active = false;
        return arrived / this.coins.length;
    }

    private trail(elapsed: number, progress: number, scale: number, x: number, y: number,
        walletX: number, walletY: number): void {
        // The original gold sprite is 0.7 Unity units across. Emit the child Star
        // texture by distance along the flight; emitted stars fade in place.
        const length = Math.hypot(walletX - x, walletY - y);
        if (!length || elapsed <= 0) return;
        const step = (142 / 0.7) * scale * this.motion.glintSpacing / length;
        for (let k = Math.floor(progress * progress / step); k > 0; k--) {
            const travel = k * step;
            const phase = Math.sqrt(travel);
            const age = (elapsed - phase * 0.64) / this.motion.glintLife;
            if (age > 1) break;
            const index = this.visibleGlints++;
            let glint = this.glints[index];
            if (!glint) {
                glint = image(this.glintLayer, 'Gold trail star', 42, this.glintFrame);
                this.glints.push(glint);
            }
            glint.node.active = true;
            const size = scale * (1 - age);
            glint.node.setScale(size, size, 1);
            glint.node.setPosition(x + (walletX - x) * travel,
                y + (walletY - y) * travel + Math.sin(phase * Math.PI) * 46 * scale, 0);
            glint.color = new Color(...this.motion.glintColor, Math.round(255 * (1 - age)));
        }
    }

    reset(): void {
        this.glintLayer.active = true;
        this.glints.forEach(sprite => { sprite.node.active = false; });
        for (const sprite of [...this.coins, ...this.sparks]) sprite.node.active = false;
    }

    destroy(): void {
        for (const frame of [...this.spin, ...this.burst, this.glintFrame]) frame.destroy();
    }
}
