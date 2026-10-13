import * as constants from '../constants.js';
import { getNativeStructFieldLayout } from './native-structs-from-js.js';
import { CppMemoryWriter } from './struct-write.js';
export function allocateNativeStructArray(module, count) {
    const nativeSize = module._get_elsetrec_size();
    return module._calloc_one(count * nativeSize);
}
export function writeNativeStructArrayFromSatrecArray(module, pointer, satrecArray) {
    const structLayoutStringPointer = module._create_elsetrec_struct_layout_string_pointer();
    const layout = getNativeStructFieldLayout(structLayoutStringPointer, module);
    module._free_struct_layout_string(structLayoutStringPointer);
    const nativeSize = module._get_elsetrec_size();
    const writer = new CppMemoryWriter(module.HEAP8.buffer);
    satrecArray.forEach((satrec, index) => {
        const currentOffset = index * nativeSize;
        writer.setBaseOffset(pointer + currentOffset);
        layout.forEach(({ type, offset, size }, field) => {
            if (Object.hasOwn(constants, field)) {
                writer.writeValue(field, offset, type, 
                // biome-ignore lint/performance/noDynamicNamespaceImportAccess: all constants needed here
                constants[field], size);
            }
            if (field === 'no_unkozai') {
                writer.writeValue(field, offset, type, satrec.no, size);
            }
            if (field === 'radiusearthkm') {
                writer.writeValue(field, offset, type, constants.earthRadius, size);
            }
            if (!Object.hasOwn(satrec, field)) {
                return;
            }
            writer.writeValue(field, offset, type, satrec[field], size);
        });
    });
}
