import { Vec3 } from 'cc';
import type { Route } from './DispatchRound';

export const extraRoutes = ['purple', 'orange', 'pink', 'green'] as const;
export type BusRoute = Route | typeof extraRoutes[number];

export interface StagedVehicle {
    id: string;
    route: BusRoute;
    position: Vec3;
    yaw: number;
    groups?: number;
}

export interface BusLevel {
    number: number;
    entrySeconds: number;
    fillSeconds: number;
    settleRate: number;
    driveInSeconds: number;
    fleet: readonly StagedVehicle[];
    waves: ReadonlyArray<readonly [BusRoute, number]>;
    secondWaves?: ReadonlyArray<readonly [BusRoute, number]>;
    stagingMultiplier?: number;
}

function car(id: string, route: BusRoute, x: number, z: number, yaw: number): StagedVehicle {
    return { id, route, position: new Vec3(x, 0, z), yaw };
}

export const levelOne: BusLevel = {
    number: 1, entrySeconds: 1.35, fillSeconds: 4.65, settleRate: 0.31, driveInSeconds: 0.56,
    fleet: [
        car('B1', 'teal', -0.90, -2.54, 60), car('Y1', 'amber', -0.73, -3.30, -30),
        car('Y2', 'amber', -0.29, -3.05, -30), car('B2', 'teal', 1.04, -3.40, -30),
        car('R1', 'red', 0.30, -3.53, 60), car('R2', 'red', 0.51, -3.94, 60),
    ],
    waves: [['teal', 40], ['red', 40], ['teal', 40], ['amber', 40], ['red', 40], ['amber', 40]],
};

// Linear-space display calibration from the four parked roof colors in the walkthrough.
export const secondPaintGain = {
    purple: [0.73, 0.34, 1.03], orange: [1.03, 0.60, 0.35],
    pink: [1.07, 0.37, 0.93], green: [0.41, 1.29, 0.84],
} as const;

// The second board is measured in the same camera projection as the first.
// Wave order follows the four colors entering the belt in the walkthrough.
export const levelTwo: BusLevel = {
    number: 2, entrySeconds: 0.85, fillSeconds: 4.30, settleRate: 0.20, driveInSeconds: 0.46,
    fleet: [
        car('V1', 'purple', 0.62, -2.01, -90), car('V2', 'purple', -0.68, -2.01, -90),
        car('V3', 'purple', 0.99, -2.69, 0), car('O1', 'orange', 0.35, -2.69, 0),
        car('P1', 'pink', -0.29, -2.69, 0), car('O2', 'orange', -0.94, -2.69, 0),
        car('G1', 'green', 0.71, -3.42, 90), car('G2', 'green', -0.63, -3.42, 90),
        car('O3', 'orange', 0.99, -4.15, 0), car('P2', 'pink', 0.35, -4.15, 0),
        car('O4', 'orange', -0.29, -4.15, 0), car('G3', 'green', -0.94, -4.15, 0),
    ],
    waves: [
        ['purple', 40], ['orange', 40], ['purple', 20], ['pink', 40], ['orange', 20],
        ['green', 20], ['orange', 20], ['purple', 40], ['green', 20], ['orange', 20],
        ['green', 40], ['orange', 20], ['pink', 20], ['green', 20], ['pink', 20],
        ['orange', 20], ['green', 20], ['purple', 20], ['orange', 20],
    ],
};

export interface AuthoredBoard {
    fleet: { id: string; route: BusRoute; groups: number; x: number; z: number; yaw: number }[];
    streams: [BusLevel['waves'], BusLevel['waves']];
    mapScale: number;
}

export function makeThirdLevel(data: AuthoredBoard): BusLevel {
    return {
        number: 3, entrySeconds: 0.96, fillSeconds: 2.54, settleRate: 0.42, driveInSeconds: 0.55,
        fleet: data.fleet.map(v => ({
            ...v,
            // Unity's board is mirrored on X and placed on the foreground of the depot.
            position: new Vec3(-v.x * data.mapScale, 0, v.z * data.mapScale - 3.23),
        })),
        waves: data.streams[0], secondWaves: data.streams[1], stagingMultiplier: data.mapScale,
    };
}

export function vehicleSeats(v: StagedVehicle): number {
    return (v.groups ?? 10) * 4;
}
