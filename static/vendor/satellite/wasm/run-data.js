import { CppMemoryWriter } from './struct-write.js';
export function allocateRunData(module) {
    const runDataSize = module._get_rundata_size();
    return module._calloc_one(runDataSize);
}
export function passRunDataToWasm(module, runDataStruct, runData, runDataPointer) {
    const writer = new CppMemoryWriter(module.HEAP8.buffer, runDataPointer);
    Object.entries(runData).forEach(([fieldName, value]) => {
        const fieldLayout = runDataStruct.get(fieldName);
        if (!fieldLayout) {
            throw new Error(`Field ${fieldName} not found in RunData struct layout. Please file an issue to satellite.js.`);
        }
        writer.writeValue(fieldName, fieldLayout.offset, fieldLayout.type, value, fieldLayout.size);
    });
    return runDataPointer;
}
