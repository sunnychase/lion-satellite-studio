const DIMENSIONS = 3;
const BYTES_PER_VECTOR = DIMENSIONS * Float64Array.BYTES_PER_ELEMENT;
/**
 * Performs SGP4 propagation, producing ECI (Earth-Centered Fixed) position
 * and velocity vectors. Base calculator with no dependencies.
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `position`: `Float64Array`, packed as [x0, y0, z0, x1, y1, z1, ...]
 * for each satellite/date pair
 *   - `velocity`: `Float64Array`, packed as [vx0, vy0, vz0, vx1, vy1, vz1, ...]
 * for each satellite/date pair
 *   - `error`: `Int8Array`, equal to SatRec.error, packed as [err0, err1, ...]
 * for each satellite/date pair
 *
 * Provides formatted output under `eci` property, @see EciBaseFormattedOutput.
 */
export class EciBaseCalculator {
    name = 'eci';
    dependencies = [];
    satellitesCount;
    datesCount;
    module;
    outputPointer;
    init(module, outputPointer, satellitesCount, datesCount) {
        this.module = module;
        this.outputPointer = outputPointer;
        this.satellitesCount = satellitesCount;
        this.datesCount = datesCount;
    }
    getFormattedOutput(satelliteIndex, dateIndex) {
        const { position, velocity, error } = this.getRawOutput();
        const index = (satelliteIndex * this.datesCount + dateIndex) * DIMENSIONS;
        return {
            // biome-ignore-start lint/style/noNonNullAssertion: index math
            position: {
                x: position[index],
                y: position[index + 1],
                z: position[index + 2],
            },
            velocity: {
                x: velocity[index],
                y: velocity[index + 1],
                z: velocity[index + 2],
            },
            // biome-ignore-end lint/style/noNonNullAssertion: index math
            error: error[satelliteIndex * this.datesCount + dateIndex],
        };
    }
    getRawOutput() {
        const vectorsSize = this.satellitesCount * this.datesCount * DIMENSIONS;
        const position = new Float64Array(this.module.HEAP8.buffer, this.outputPointer, vectorsSize);
        const velocity = new Float64Array(this.module.HEAP8.buffer, position.byteOffset + position.byteLength, vectorsSize);
        const error = new Int8Array(this.module.HEAP8.buffer, velocity.byteOffset + velocity.byteLength, this.satellitesCount * this.datesCount);
        return {
            position,
            velocity,
            error,
        };
    }
    getOutputBufferSize(satellitesCount, datesCount) {
        return (BYTES_PER_VECTOR * satellitesCount * datesCount * 2 +
            Int8Array.BYTES_PER_ELEMENT * satellitesCount * datesCount);
    }
    getExecutionDescriptor(runParameters) {
        const eciVelocitiesPointer = this.outputPointer +
            BYTES_PER_VECTOR * this.satellitesCount * this.datesCount;
        return {
            communityDecayCheckEnabled: runParameters.communityDecayCheckEnabled ?? false,
            eciPositions: this.outputPointer,
            eciVelocities: eciVelocitiesPointer,
            sgp4Errors: eciVelocitiesPointer +
                BYTES_PER_VECTOR * this.satellitesCount * this.datesCount,
        };
    }
}
