/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The command line `konjugateEngine fit` is started with, for both editions (the desktop engine process and the web engine's module):
// one place that turns a tuning setup into arguments, so an option added for one cannot be forgotten by the other. `paths` are where
// the engine will find its files; `objectivePath`, `stopPath` and `progress` are for the editions that have them (the desktop one streams
// progress and is stopped through a file; the web one reports a fit only when it ends).
export function fitArguments({ inputPath, csvPath, reportPath, objectivePath = null, stopPath = null, progress = false }, config = {}) {
    const args = ['fit', inputPath, csvPath, '--report', reportPath];
    if (progress) args.push('--progress-stream');
    if (stopPath) args.push('--stop-file', stopPath);
    if (config.backend !== undefined) args.push('--backend', config.backend);
    if (config.maxIterations !== undefined) args.push('--max-iterations', String(config.maxIterations));
    if (config.maxSeconds > 0) args.push('--max-seconds', String(config.maxSeconds));
    if (config.objective) {
        if (!objectivePath) throw new Error('A fit with an objective needs somewhere to write the objective.');
        args.push('--objective-file', objectivePath);
    }
    return args;
}
