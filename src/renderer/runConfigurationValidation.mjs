/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The numerical and execution settings in the Run dialog, checked before a run starts or the model's
// run configuration is saved. The engine checks the same rules again (simulationRunner.cpp); this is
// so the dialog can say what is wrong in plain words instead of the engine failing at launch.

export function validateRunConfigurationValues({ globalTimeStep, outputInterval, execution }) {
    const validExecution = Number.isInteger(execution.workerThreads) && execution.workerThreads >= 1 && execution.workerThreads <= 256 &&
        Number.isInteger(execution.partitionCount) && execution.partitionCount >= 1 && execution.partitionCount <= 256 &&
        Number.isFinite(execution.partitionCommunicationBias) && execution.partitionCommunicationBias >= 0 &&
        Number.isInteger(execution.automaticParallelThreshold) && execution.automaticParallelThreshold >= 1 &&
        execution.automaticParallelThreshold <= 1000000 &&
        Number.isFinite(execution.automaticMaximumPartitionCutFraction) &&
        execution.automaticMaximumPartitionCutFraction >= 0 && execution.automaticMaximumPartitionCutFraction <= 1;
    if (!validExecution) return 'Execution values must be within their displayed bounds.';
    const outputRatio = outputInterval / globalTimeStep;
    if (!(globalTimeStep > 0) || !Number.isFinite(globalTimeStep) || !(outputInterval > 0) || !Number.isFinite(outputInterval) ||
        outputInterval < globalTimeStep || Math.abs(outputRatio - Math.round(outputRatio)) > 1e-9) {
        return 'Use positive values; output interval must be an integer multiple of the global timestep.';
    }
    return null;
}

// A run must cover at least one global timestep beyond where it starts. The tolerance absorbs
// floating-point error: a fork or restart at the final sample defaults the target to
// startTime + globalTimeStep, and that difference can land a hair below the step.
export function targetTimeIsReachable(targetTime, startTime, globalTimeStep) {
    return targetTime > startTime && targetTime - startTime >= globalTimeStep - globalTimeStep * 1e-9;
}
