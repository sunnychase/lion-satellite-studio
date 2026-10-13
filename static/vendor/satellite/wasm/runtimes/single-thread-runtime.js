import { getNativeStructFieldLayout } from '../native-structs-from-js.js';
import { passRunDataToWasm } from '../run-data.js';
export async function createSingleThreadRuntimeFromModule(wasmModule) {
    const runDataStructLayoutStringPointer = wasmModule._create_rundata_struct_layout_string_pointer();
    const runDataLayout = getNativeStructFieldLayout(runDataStructLayoutStringPointer, wasmModule);
    wasmModule._free(runDataStructLayoutStringPointer);
    const compute = (runData, runDataPointer) => {
        passRunDataToWasm(wasmModule, runDataLayout, runData, runDataPointer);
        wasmModule._compute(runDataPointer);
    };
    return {
        mode: 'single',
        module: wasmModule,
        compute,
        dispose: () => {
            wasmModule._exit_runtime();
        },
        [Symbol.dispose]: () => { },
    };
}
