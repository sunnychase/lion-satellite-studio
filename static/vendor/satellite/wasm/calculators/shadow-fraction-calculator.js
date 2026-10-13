/**
 * Calculator for shadow fraction.
 *
 * Computes the fraction of the Sun's disc obscured by the Earth as seen from a satellite
 * at a date. This is the WASM equivalent of the pure-JS `shadowFunction`.
 *
 * Depends on:
 * @see EciBaseCalculator
 * @see SunPositionCalculator
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `Float64Array`, packed as [shadow0, shadow1, ...] for each satellite/date pair
 *     where 0 = fully lit, 1 = umbra, 0–1 = penumbra fraction
 *
 * Provides formatted output as a number under `shadowFraction` property.
 */
export class ShadowFractionCalculator {
    name = 'shadowFraction';
    dependencies = ['eci', 'sunPosition'];
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
        const index = satelliteIndex * this.datesCount + dateIndex;
        // biome-ignore lint/style/noNonNullAssertion: index math
        return rawOutput[index];
    }
    getRawOutput() {
        return new Float64Array(this.module.HEAP8.buffer, this.outputPointer, this.satellitesCount * this.datesCount);
    }
    getOutputBufferSize(satellitesCount, datesCount) {
        return satellitesCount * datesCount * Float64Array.BYTES_PER_ELEMENT;
    }
    getExecutionDescriptor() {
        return {
            shadowFractionEnabled: true,
            shadowFractionValues: this.outputPointer,
        };
    }
}
