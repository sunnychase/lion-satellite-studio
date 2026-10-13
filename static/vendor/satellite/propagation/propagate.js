import { minutesPerDay } from '../constants.js';
import { jday } from '../ext.js';
import { checkForDecay } from './check-for-decay.js';
import { SatRecError } from './SatRec.js';
import { sgp4 } from './sgp4.js';
export function propagate(satrec, 
// Deliberately permissive: the overloads above define the public contract, and
// TypeScript only requires the implementation signature to be compatible with
// all of them.
...args) {
    // Return a position and velocity vector for a given date and time.
    const last = args.at(-1);
    const options = typeof last === 'object' && !(last instanceof Date) ? last : undefined;
    const jdayArgs = (options ? args.slice(0, -1) : args);
    const j = jday(...jdayArgs);
    const m = (j - satrec.jdsatepoch) * minutesPerDay;
    const result = sgp4(satrec, m);
    // sgp4 sometimes propagates satellites that decayed long ago to meaningless positions
    // rather than reporting them as decayed; opting in reports them like sgp4 does.
    if (options?.communityDecayCheckEnabled && result && checkForDecay(satrec)) {
        satrec.error = SatRecError.Decayed;
        return null;
    }
    return result;
}
