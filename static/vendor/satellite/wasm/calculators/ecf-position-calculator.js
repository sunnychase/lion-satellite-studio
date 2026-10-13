const DIMENSIONS = 3;
/**
 * Calculator for ECF (Earth-Centered Fixed) position.
 *
 * Depends on:
 * @see EciBaseCalculator
 * @see GmstCalculator
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `Float64Array`, packed as [x0, y0, z0, x1, y1, z1, ...] for each satellite/date pair
 *
 * Provides formatted output under `ecfPosition` property.
 */
export class EcfPositionCalculator {
    name = 'ecfPosition';
    dependencies = ['eci', 'gmst'];
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
        const rawOutput = this.getRawOutput();
        const index = (satelliteIndex * this.datesCount + dateIndex) * DIMENSIONS;
        return {
            // biome-ignore-start lint/style/noNonNullAssertion: index math
            x: rawOutput[index],
            y: rawOutput[index + 1],
            z: rawOutput[index + 2],
            // biome-ignore-end lint/style/noNonNullAssertion: index math
        };
    }
    getOutputBufferSize(satellitesCount, datesCount) {
        return (satellitesCount * datesCount * DIMENSIONS * Float64Array.BYTES_PER_ELEMENT);
    }
    getRawOutput() {
        return new Float64Array(this.module.HEAP8.buffer, this.outputPointer, this.satellitesCount * this.datesCount * DIMENSIONS);
    }
    getExecutionDescriptor() {
        return {
            ecfPositionEnabled: true,
            ecfPositions: this.outputPointer,
        };
    }
}
