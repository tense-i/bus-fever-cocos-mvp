export type Route = 'teal' | 'amber' | 'red';

export interface Vehicle {
    id: string;
    route: Route;
}

interface Bay {
    vehicle: Vehicle;
    seatsLeft: number;
}

export type Outcome = 'playing' | 'won' | 'lost';

export interface BoardingStep {
    vehicleId: string;
    departed: boolean;
}

export interface RoundLayout {
    vehicles: readonly Vehicle[];
    queue: readonly Route[];
    capacity: number;
    bayCount: number;
}

export const fleet: readonly Vehicle[] = [
    { id: 'T1', route: 'teal' },
    { id: 'A1', route: 'amber' },
    { id: 'T2', route: 'teal' },
    { id: 'A2', route: 'amber' },
];

const groups: readonly Route[] = ['teal', 'amber', 'teal', 'amber'];
const depotLayout: RoundLayout = {
    vehicles: fleet,
    queue: groups.flatMap((route) => [route, route]),
    capacity: 2,
    bayCount: 2,
};

export class DispatchRound {
    readonly queue: Route[];
    readonly bays: Bay[] = [];
    readonly ready: Set<string>;
    outcome: Outcome = 'playing';

    constructor(private readonly layout: RoundLayout = depotLayout) {
        this.queue = [...layout.queue];
        this.ready = new Set(layout.vehicles.map((vehicle) => vehicle.id));
    }

    get boarded(): number {
        return this.layout.queue.length - this.queue.length;
    }

    dispatch(vehicle: Vehicle): boolean {
        return this.dispatchWithTrace(vehicle) !== null;
    }

    dispatchWithTrace(vehicle: Vehicle): BoardingStep[] | null {
        if (this.outcome !== 'playing' || !this.ready.delete(vehicle.id)) {
            return null;
        }

        this.bays.push({ vehicle, seatsLeft: this.layout.capacity });
        const boardings = this.boardWaitingPassengers();

        if (this.queue.length === 0) {
            this.outcome = 'won';
        } else if (this.bays.length === this.layout.bayCount) {
            this.outcome = 'lost';
        }
        return boardings;
    }

    private boardWaitingPassengers(): BoardingStep[] {
        const boardings: BoardingStep[] = [];
        while (this.queue.length > 0) {
            const index = this.bays.findIndex(({ vehicle }) => vehicle.route === this.queue[0]);
            if (index === -1) {
                break;
            }
            const bay = this.bays[index];
            this.queue.shift();
            bay.seatsLeft--;
            const departed = bay.seatsLeft === 0;
            boardings.push({ vehicleId: bay.vehicle.id, departed });
            if (departed) {
                this.bays.splice(index, 1);
            }
        }
        return boardings;
    }
}
