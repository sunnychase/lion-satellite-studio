export var SatRecError;
(function (SatRecError) {
    /**
     * No error, propagation for the last supplied date is successful
     */
    SatRecError[SatRecError["None"] = 0] = "None";
    /**
     * Mean eccentricity is out of range 0 ≤ e < 1
     */
    SatRecError[SatRecError["MeanEccentricityOutOfRange"] = 1] = "MeanEccentricityOutOfRange";
    /**
     * Mean motion has fallen below zero.
     */
    SatRecError[SatRecError["MeanMotionBelowZero"] = 2] = "MeanMotionBelowZero";
    /**
     * Perturbed eccentricity is out of range 0 ≤ e < 1
     */
    SatRecError[SatRecError["PerturbedEccentricityOutOfRange"] = 3] = "PerturbedEccentricityOutOfRange";
    /**
     * Length of the orbit’s semi-latus rectum has fallen below zero.
     */
    SatRecError[SatRecError["SemiLatusRectumBelowZero"] = 4] = "SemiLatusRectumBelowZero";
    // 5 is not used
    /**
     * Orbit has decayed: the computed position is underground.
     */
    SatRecError[SatRecError["Decayed"] = 6] = "Decayed";
})(SatRecError || (SatRecError = {}));
