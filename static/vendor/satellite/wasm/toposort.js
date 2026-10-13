export function topologicalSort(items) {
    const visited = new Set();
    let someRemoved = true;
    while (someRemoved) {
        someRemoved = false;
        for (const { provides, hasDependencies } of items) {
            if (hasDependencies.every((dep) => visited.has(dep)) &&
                !visited.has(provides)) {
                visited.add(provides);
                someRemoved = true;
            }
        }
    }
    if (visited.size !== items.length) {
        throw new Error('Cyclic dependency detected');
    }
    return Array.from(visited);
}
