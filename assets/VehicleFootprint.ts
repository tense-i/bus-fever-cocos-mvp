import type { StagedVehicle } from './BusLevels';

export interface VehicleFootprint {
    width: number;
    length: number;
    centerZ: number;
}

// Intersect the time intervals on all four separating axes as the clicked
// vehicle travels along its arrow. The entry time is its distance to contact.
export function distanceToBlocker(car: StagedVehicle, body: VehicleFootprint,
    other: StagedVehicle, obstacle: VehicleFootprint): number {
    const a = car.yaw * Math.PI / 180, b = other.yaw * Math.PI / 180;
    const ax = Math.sin(a), az = Math.cos(a), bx = Math.sin(b), bz = Math.cos(b);
    const x = other.position.x + bx * obstacle.centerZ - car.position.x - ax * body.centerZ;
    const z = other.position.z + bz * obstacle.centerZ - car.position.z - az * body.centerZ;
    if (x * ax + z * az <= 0) return Infinity;
    let entry = 0, exit = Infinity;
    for (const [nx, nz] of [[ax, az], [az, -ax], [bx, bz], [bz, -bx]]) {
        const speed = ax * nx + az * nz;
        const radius = (body.length * Math.abs(speed) + body.width * Math.abs(az * nx - ax * nz)
            + obstacle.length * Math.abs(bx * nx + bz * nz) + obstacle.width * Math.abs(bz * nx - bx * nz)) * 0.5;
        const delta = x * nx + z * nz;
        if (Math.abs(speed) < 1e-6) {
            if (Math.abs(delta) >= radius - 1e-6) return Infinity;
        } else {
            const start = (delta - radius) / speed, end = (delta + radius) / speed;
            entry = Math.max(entry, Math.min(start, end));
            exit = Math.min(exit, Math.max(start, end));
            if (entry > exit) return Infinity;
        }
    }
    return entry;
}
