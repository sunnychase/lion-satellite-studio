/**
 * Calculator for Doppler factor.
 *
 * Depends on:
 * @see EcfPositionCalculator
 * @see EcfVelocityCalculator
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `Float64Array`, packed as [dopplerFactor0, dopplerFactor1, ...] for each satellite/date pair
 *
 * Provides formatted output as a number under `dopplerFactor` property.
 */
export class DopplerFactorCalculator {
    name = 'dopplerFactor';
    dependencies = [
        'ecfPosition',
        'ecfVelocity',
    ];
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
    getExecutionDescriptor(runParameters) {
        return {
            dopplerFactorEnabled: true,
            observerEcfX: runParameters.observer.x,
            observerEcfY: runParameters.observer.y,
            observerEcfZ: runParameters.observer.z,
            dopplerFactors: this.outputPointer,
        };
    }
}
