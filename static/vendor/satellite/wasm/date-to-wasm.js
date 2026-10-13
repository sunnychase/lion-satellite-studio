import { jday } from '../ext.js';
export function allocateDatesArray(module, datesCount) {
    const pointer = module._malloc(datesCount * Float64Array.BYTES_PER_ELEMENT);
    return pointer;
}
export function writeDatesArray(module, pointer, dates) {
    const startOffset = pointer / Float64Array.BYTES_PER_ELEMENT;
    dates.forEach((date, index) => {
        module.HEAPF64[startOffset + index] = jday(date);
    });
}
