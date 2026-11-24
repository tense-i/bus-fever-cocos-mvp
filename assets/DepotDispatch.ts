import { _decorator, Color, Component, Graphics, Label, log, Node, profiler, UITransform } from 'cc';
import { DispatchRound, fleet } from './DispatchRound';

const { ccclass } = _decorator;
const width = 480;
const height = 900;

const palette = {
    canvas: '#10191C',
    panel: '#1C2A2E',
    track: '#26363B',
    line: '#34474C',
    ink: '#F3F4E8',
    muted: '#A4B9B6',
    dimmed: '#57716F',
    teal: '#75DEC7',
    amber: '#FFBD75',
    red: '#FF947A',
    loss: '#FF947A',
};

interface Surface {
    node: Node;
    graphics: Graphics;
}

@ccclass('DepotDispatch')
export class DepotDispatch extends Component {
    private round = new DispatchRound();
    private startScreen!: Node;
    private playScreen!: Node;
    private layout!: Node;
    private status!: Label;
    private progress!: Label;
    private queue!: Surface;
    private bays!: Surface[];
    private bayNames!: Label[];
    private busCards!: Surface[];
    private busNames!: Label[];
    private restartText!: Label;

    onLoad(): void {
        profiler.hideStats();

        this.layout = this.makeNode(this.node, 'Depot layout', 0, 0, width, height);
        const backdrop = this.makeSurface(this.layout, 'Background', 0, 0, width, height);
        this.fill(backdrop.graphics, palette.canvas, -width / 2, -height / 2, width, height, 0);
        this.makeLabel(this.layout, 'DEPOT DISPATCH', 0, 392, 32, palette.ink);
        this.startScreen = this.makeNode(this.layout, 'Welcome', 0, 0, width, height);
        this.playScreen = this.makeNode(this.layout, 'Dispatch', 0, 0, width, height);

        this.createStartScreen();
        this.createPlayScreen();
        this.playScreen.active = false;
        this.resizeLayout();
        this.node.on(Node.EventType.SIZE_CHANGED, this.resizeLayout, this);
        log('[DepotDispatch] screen=welcome');
    }

    onDestroy(): void {
        this.node.off(Node.EventType.SIZE_CHANGED, this.resizeLayout, this);
    }

    private resizeLayout(): void {
        const size = this.node.getComponent(UITransform)!.contentSize;
        const scale = Math.min(size.width / width, size.height / height);
        this.layout.setScale(scale, scale, 1);
    }

    private createStartScreen(): void {
        const illustration = this.makeSurface(this.startScreen, 'Garage illustration', 0, 95, 406, 238);
        const { graphics } = illustration;
        this.fill(graphics, palette.panel, -203, -119, 406, 238, 20);
        this.fill(graphics, palette.line, -169, -46, 338, 3, 0);
        this.drawBus(graphics, -78, 12, palette.teal, 1.6);
        this.drawBus(graphics, 78, 12, palette.amber, 1.6);
        this.makeLabel(this.startScreen, 'Match the queue to the fleet', 0, -73, 24, palette.ink);
        this.makeLabel(this.startScreen, 'Two seats per bus. Two bays at the depot.', 0, -122, 17, palette.muted);

        const start = this.makeSurface(this.startScreen, 'Start route', 0, -232, 302, 62);
        this.fill(start.graphics, palette.teal, -151, -31, 302, 62, 12);
        this.makeLabel(start.node, 'START ROUTE', 0, 0, 22, palette.canvas);
        start.node.on(Node.EventType.TOUCH_END, () => this.begin('enter'));
    }

    private createPlayScreen(): void {
        const parent = this.playScreen;
        this.status = this.makeLabel(parent, '', 0, 322, 28, palette.ink);
        this.progress = this.makeLabel(parent, '', 0, 277, 17, palette.muted);

        this.makeLabel(parent, 'PASSENGER QUEUE', 0, 213, 17, palette.muted);
        this.queue = this.makeSurface(parent, 'Passenger queue', 0, 155, 416, 66);

        this.makeLabel(parent, 'DISPATCH BAYS', 0, 81, 17, palette.muted);
        this.bays = [-106, 106].map((x) => this.makeSurface(parent, 'Bay', x, 15, 196, 84));
        this.bayNames = this.bays.map(({ node }) => this.makeLabel(node, '', 0, -22, 15, palette.muted));

        this.makeLabel(parent, 'TAP A BUS TO DISPATCH', 0, -77, 17, palette.muted);
        this.busCards = fleet.map((vehicle, index) => {
            const x = index % 2 === 0 ? -106 : 106;
            const y = index < 2 ? -149 : -258;
            const card = this.makeSurface(parent, vehicle.id, x, y, 196, 94);
            card.node.on(Node.EventType.TOUCH_END, () => {
                if (this.round.dispatch(vehicle)) {
                    this.refresh();
                    this.record('dispatch', vehicle.id);
                }
            });
            return card;
        });
        this.busNames = this.busCards.map(({ node }) => this.makeLabel(node, '', 0, -27, 16, palette.ink));

        const restart = this.makeSurface(parent, 'Restart', 0, -363, 302, 57);
        this.fill(restart.graphics, palette.track, -151, -28.5, 302, 57, 12);
        this.restartText = this.makeLabel(restart.node, '', 0, 0, 19, palette.ink);
        restart.node.on(Node.EventType.TOUCH_END, () => this.begin('restart'));
    }

    private begin(event: 'enter' | 'restart'): void {
        this.round = new DispatchRound();
        this.startScreen.active = false;
        this.playScreen.active = true;
        this.refresh();
        this.record(event);
    }

    private refresh(): void {
        const { boarded, outcome, queue, bays, ready } = this.round;
        const status = {
            playing: 'Load the next passengers',
            won: 'Route complete',
            lost: 'Depot blocked',
        };
        const caption = {
            playing: 'First in line boards first',
            won: 'All passengers boarded',
            lost: 'Both bays are full',
        };
        this.status.string = status[outcome];
        this.status.color = this.color(outcome === 'won' ? palette.teal : outcome === 'lost' ? palette.loss : palette.ink);
        this.progress.string = `${boarded}/8 boarded    |    ${caption[outcome]}`;
        this.restartText.string = outcome === 'playing' ? 'RESTART' : 'PLAY AGAIN';

        const queueGraphics = this.queue.graphics;
        queueGraphics.clear();
        this.fill(queueGraphics, palette.panel, -208, -33, 416, 66, 14);
        queue.forEach((route, index) => {
            const x = -176 + index * 49;
            const size = index === 0 ? 34 : 28;
            this.fill(queueGraphics, palette[route], x - size / 2, -size / 2, size, size, size / 2);
        });

        this.bays.forEach(({ graphics }, index) => {
            const bay = bays[index];
            graphics.clear();
            this.fill(graphics, palette.panel, -98, -42, 196, 84, 13);
            if (bay) {
                this.drawBus(graphics, 0, 11, palette[bay.vehicle.route], 0.72);
            } else {
                this.fill(graphics, palette.line, -20, 9, 40, 3, 1);
            }
            this.bayNames[index].string = bay ? `${bay.vehicle.id}   ${bay.seatsLeft} SEATS` : 'EMPTY';
        });

        this.busCards.forEach(({ graphics }, index) => {
            const vehicle = fleet[index];
            const available = ready.has(vehicle.id);
            graphics.clear();
            this.fill(graphics, available ? palette.track : palette.panel, -98, -47, 196, 94, 12);
            this.drawBus(graphics, 0, 9, available ? palette[vehicle.route] : palette.dimmed, 0.87);
            this.busNames[index].string = available ? `${vehicle.route.toUpperCase()} ${vehicle.id.slice(1)}` : 'DISPATCHED';
            this.busNames[index].color = this.color(available ? palette.ink : palette.muted);
        });
    }

    private record(event: string, vehicle?: string): void {
        const { bays, boarded, outcome, queue, ready } = this.round;
        log(`[DepotDispatch] ${JSON.stringify({
            event,
            vehicle,
            boarded,
            outcome,
            front: queue[0] ?? null,
            bays: bays.map(({ vehicle, seatsLeft }) => ({ id: vehicle.id, seatsLeft })),
            ready: [...ready],
        })}`);
    }

    private makeNode(parent: Node, name: string, x: number, y: number, w: number, h: number): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.parent = parent;
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        return node;
    }

    private makeSurface(parent: Node, name: string, x: number, y: number, w: number, h: number): Surface {
        const node = this.makeNode(parent, name, x, y, w, h);
        return { node, graphics: node.addComponent(Graphics) };
    }

    private makeLabel(parent: Node, text: string, x: number, y: number, size: number, color: string): Label {
        const node = this.makeNode(parent, 'Label', x, y, width, size + 10);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 4;
        label.color = this.color(color);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;
        return label;
    }

    private drawBus(graphics: Graphics, x: number, y: number, color: string, scale: number): void {
        this.fill(graphics, palette.canvas, x - 31 * scale, y - 18 * scale, 13 * scale, 9 * scale, 3 * scale);
        this.fill(graphics, palette.canvas, x + 17 * scale, y - 18 * scale, 13 * scale, 9 * scale, 3 * scale);
        this.fill(graphics, color, x - 43 * scale, y - 13 * scale, 86 * scale, 31 * scale, 7 * scale);
        this.fill(graphics, palette.canvas, x + 14 * scale, y - 2 * scale, 19 * scale, 12 * scale, 3 * scale);
        for (const offset of [-34, -18, -2]) {
            this.fill(graphics, palette.track, x + offset * scale, y - 1 * scale, 11 * scale, 11 * scale, 2 * scale);
        }
    }

    private fill(graphics: Graphics, color: string, x: number, y: number, w: number, h: number, radius: number): void {
        graphics.fillColor = this.color(color);
        graphics.roundRect(x, y, w, h, radius);
        graphics.fill();
    }

    private color(value: string): Color {
        return Color.fromHEX(new Color(), value);
    }
}
