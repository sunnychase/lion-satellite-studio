/**
 * Calculator for GMST (Greenwich Mean Sidereal Time), required for many coordinate transforms.
 *
 * Raw output format:
 *   - `Float64Array`, packed as [gmst0, gmst1, ...] for each date. Not duplicated per satellite.
 *
 * Provides formatted output as a number under `gmst` property.
 */
export class GmstCalculator {
    name = 'gmst';
    dependencies = [];
    module;
    outputPointer;
    datesCount;
    getOutputBufferSize(_satellitesCount, datesCount) {
        return datesCount * Float64Array.BYTES_PER_ELEMENT;
    }
    init(module, outputPointer, _satellitesCount, datesCount) {
        this.module = module;
        this.outputPointer = outputPointer;
        this.datesCount = datesCount;
    }
    getRawOutput() {
        return new Float64Array(this.module.HEAP8.buffer, this.outputPointer, this.datesCount);
    }
    getFormattedOutput(_satelliteIndex, dateIndex) {
        // biome-ignore lint/style/noNonNullAssertion: index math
        return this.getRawOutput()[dateIndex];
    }
    getExecutionDescriptor() {
        return {
            gmstEnabled: true,
            gmstValues: this.outputPointer,
        };
    }
}
