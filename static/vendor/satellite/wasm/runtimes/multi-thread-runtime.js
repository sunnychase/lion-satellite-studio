import { getNativeStructFieldLayout } from '../native-structs-from-js.js';
import { passRunDataToWasm } from '../run-data.js';
export async function createMultiThreadRuntimeFromModule(wasmModule, options) {
    const runDataStructLayoutStringPointer = wasmModule._create_rundata_struct_layout_string_pointer();
    const runDataLayout = getNativeStructFieldLayout(runDataStructLayoutStringPointer, wasmModule);
    wasmModule._free(runDataStructLayoutStringPointer);
    const originalCompute = wasmModule.cwrap('compute', 'number', ['number', 'number'], { async: true });
    let isRunning = false;
    const compute = async (runData, runDataPointer) => {
        if (isRunning) {
            throw new Error('Cannot run multiple computations in parallel on the same WASM runtime. Make sure to await for the previous computation to finish before starting a new one.');
        }
        isRunning = true;
        passRunDataToWasm(wasmModule, runDataLayout, runData, runDataPointer);
        try {
            await originalCompute(options.threadsCount, runDataPointer);
        }
        finally {
            isRunning = false;
        }
    };
    const runtime = {
        mode: 'multi',
        module: wasmModule,
        compute,
        dispose: () => {
            wasmModule._exit_runtime();
        },
        [Symbol.dispose]() {
            this.dispose();
        },
    };
    return runtime;
}
