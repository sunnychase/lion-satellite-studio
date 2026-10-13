export function getNativeStructFieldLayout(structLayoutStringPointer, module) {
    const structureJsonString = module.UTF8ToString(structLayoutStringPointer);
    const structureJson = JSON.parse(structureJsonString);
    return new Map(structureJson.map(([field, type, offset, size]) => [
        field,
        { type, offset, size },
    ]));
}
