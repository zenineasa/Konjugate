/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Follows a data log while a logger is still writing it (docs/connectingADataSource.md, "Reading a log"): reads only what has been
// added since the last look, hands it to the same DataLogReader a finished log is read with, and passes on the observations each
// look completed. The file adapter of docs/proposals/digitalTwinConnections.md, for a log on this computer or a shared folder.
//
//   const follower = followDataLog(path, { onHeader, onObservations, onError });
//   ...
//   await follower.stop();          // reads what is left, and treats the log as finished
//
// `onHeader(header)` is called once, when the log's description and headings have been read; `onObservations(observations, arrived)`
// each time a look finds complete readings, with `arrived` the wall-clock time they were found at. A log that waits to be created is
// fine; one that gets shorter, or breaks the format, stops the follower with the reason.

import { open } from 'node:fs/promises';
import { DataLogReader } from './dataLog.mjs';

// `reader` reads another format the same way (push, end, header): a LoggerCsvReader for a lab logger's own CSV (src/loggerCsv.mjs).
export function followDataLog(path, { onHeader = () => {}, onObservations = () => {}, onError = () => {}, pollMilliseconds = 20, reader = new DataLogReader() } = {}) {
    let handle = null;
    let offset = 0;
    let headerSeen = false;
    let stopping = false;
    let failure = null;

    const look = async () => {
        if (!handle) {
            try {
                handle = await open(path, 'r');
            } catch (error) {
                if (error.code === 'ENOENT') return; // not written yet
                throw error;
            }
        }
        const { size } = await handle.stat();
        if (size < offset) throw new Error(`${path} got shorter: a data log is only ever added to.`);
        if (size === offset) return;
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        const observations = reader.push(buffer.subarray(0, bytesRead));
        if (!headerSeen && reader.header) {
            headerSeen = true;
            onHeader(reader.header);
        }
        if (observations.length) onObservations(observations, Date.now());
    };

    const loop = (async () => {
        try {
            while (!stopping) {
                await look();
                await new Promise((resolve) => setTimeout(resolve, pollMilliseconds));
            }
            await look();
            reader.end();
        } catch (error) {
            failure = error;
            onError(error);
        } finally {
            await handle?.close();
        }
    })();

    return {
        get header() { return reader.header; },
        // Stops following: reads what is left and treats the log as finished. Rejects with the reason the follower stopped, if it did.
        async stop() {
            stopping = true;
            await loop;
            if (failure) throw failure;
        }
    };
}
