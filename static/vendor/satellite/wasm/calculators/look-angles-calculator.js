const OUTPUTS_PER_SATELLITE = 3;
/**
 * Calculator for Look Angles (azimuth, elevation, rangeSat).
 *
 * Requires observer location as a parameter for `BulkPropagator.run()` method.
 *
 * Depends on:
 * @see EcfPositionCalculator
 *
 * Raw outputs are always sorted by satellite index first, then by date index, and packed as:
 *   - `Float64Array`, packed as [az0, el0, range0, az1, el1, range1, ...]
 * for each satellite/date pair
 *
 * Provides formatted output under `lookAngles` property.
 *
 * @example
 * ```ts
 * bulkPropagator.run({
 *   dates: [...],
 *   lookAngles: {
 *     observer: {
 *      latitude: degreesToRadians(41),
 *      longitude: degreesToRadians(-71),
 *      height: 0.1,
 *    }
 *   }
 * });
 *
 * bulkPropagator.getFormattedOutput(satelliteIndex, dateIndex).lookAngles.azimuth;
 * ```
 */
export class LookAnglesCalculator {
    name = 'lookAngles';
    dependencies = ['ecfPosition'];
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
        const index = (satelliteIndex * this.datesCount + dateIndex) * OUTPUTS_PER_SATELLITE;
        return {
            // biome-ignore-start lint/style/noNonNullAssertion: index math
            azimuth: rawOutput[index],
            elevation: rawOutput[index + 1],
            rangeSat: rawOutput[index + 2],
            // biome-ignore-end lint/style/noNonNullAssertion: index math
        };
    }
    getRawOutput() {
        return new Float64Array(this.module.HEAP8.buffer, this.outputPointer, this.satellitesCount * this.datesCount * OUTPUTS_PER_SATELLITE);
    }
    getOutputBufferSize(satellitesCount, datesCount) {
        return (satellitesCount *
            datesCount *
            OUTPUTS_PER_SATELLITE *
            Float64Array.BYTES_PER_ELEMENT);
    }
    getExecutionDescriptor(runParameters) {
        const { latitude, longitude, height } = runParameters.observer;
        return {
            lookAnglesEnabled: true,
            latitudeRadians: latitude,
            longitudeRadians: longitude,
            heightKm: height,
            lookAngles: this.outputPointer,
        };
    }
}
