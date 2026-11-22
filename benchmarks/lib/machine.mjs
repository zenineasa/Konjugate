/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a timing result depends on besides Konjugate: the computer, its operating system, whether it is on mains power, and what else
// is running. Recorded with every --full run. Nothing that identifies the computer or its owner is read: no host name, user name or
// serial number.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

function command(file, args) {
    try {
        return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
    } catch {
        return '';
    }
}

function darwinDetails() {
    let hardware = {};
    try {
        hardware = JSON.parse(command('system_profiler', ['SPHardwareDataType', '-json'])).SPHardwareDataType?.[0] ?? {};
    } catch {
        hardware = {};
    }
    const battery = command('pmset', ['-g', 'batt']);
    const settings = command('pmset', ['-g']);
    const lowPower = /lowpowermode\s+(\d)/.exec(settings);
    return {
        model: hardware.machine_name ?? null,
        modelIdentifier: command('sysctl', ['-n', 'hw.model']) || null,
        chip: hardware.chip_type ?? null,
        cpu: command('sysctl', ['-n', 'machdep.cpu.brand_string']) || os.cpus()[0]?.model || null,
        performanceCores: Number(command('sysctl', ['-n', 'hw.perflevel0.physicalcpu'])) || null,
        efficiencyCores: Number(command('sysctl', ['-n', 'hw.perflevel1.physicalcpu'])) || null,
        operatingSystem: `macOS ${command('sw_vers', ['-productVersion'])} (${command('sw_vers', ['-buildVersion'])})`,
        power: {
            source: /'(AC Power|Battery Power)'/.exec(battery)?.[1] ?? null,
            batteryPercent: Number(/(\d+)%/.exec(battery)?.[1]) || null,
            lowPowerMode: lowPower ? lowPower[1] === '1' : null
        }
    };
}

function linuxDetails() {
    const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
    const release = read('/etc/os-release') ?? '';
    const powerOnline = ['/sys/class/power_supply/AC/online', '/sys/class/power_supply/ACAD/online'].map(read).find((value) => value !== null);
    return {
        model: read('/sys/class/dmi/id/product_name'),
        modelIdentifier: read('/sys/class/dmi/id/product_version'),
        chip: null,
        cpu: os.cpus()[0]?.model ?? null,
        operatingSystem: /PRETTY_NAME="([^"]+)"/.exec(release)?.[1] ?? `Linux ${os.release()}`,
        power: { source: powerOnline === undefined ? null : powerOnline === '1' ? 'AC Power' : 'Battery Power', governor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') }
    };
}

export function machineDetails() {
    const specific = process.platform === 'darwin' ? darwinDetails() : process.platform === 'linux' ? linuxDetails() : {
        model: null, modelIdentifier: null, chip: null, cpu: os.cpus()[0]?.model ?? null, operatingSystem: `${os.type()} ${os.release()}`, power: { source: null }
    };
    return {
        ...specific,
        platform: process.platform,
        architecture: process.arch,
        logicalProcessors: os.cpus().length,
        memoryBytes: os.totalmem(),
        node: process.version,
        loadAverage: os.loadavg().map((value) => Number(value.toFixed(2)))
    };
}

// A short, stable name for the computer kind, for the results directory: model identifier and chip or CPU, never the host name.
export function machineSlug(details) {
    const parts = [details.modelIdentifier ?? details.model, details.chip ?? details.cpu, details.platform].filter(Boolean);
    return parts.join('-').toLowerCase().replace(/\(r\)|\(tm\)|cpu|@.*$/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown-machine';
}

// Processes that would disturb a timing run: Konjugate's interaction suites, Konjugate's own Electron (the development build or the
// installed app, not every Electron-based application on the computer), and browsers driven by tests.
export const busyPatterns = [
    { name: 'interaction test runner', pattern: /interactionRunner|runInteractionTests|runWebInteractionTests|runWebAddonTests|runPackagedInteractionTests/ },
    { name: 'Konjugate Electron', pattern: /node_modules\/electron\/dist\/|Konjugate\.app\/Contents\/|Konjugate\.exe/ },
    { name: 'test-driven Chrome', pattern: /Chrome for Testing|chrome-headless-shell|chromedriver|--remote-debugging-(port|pipe)|puppeteer|playwright/i }
];

export function busyProcesses() {
    if (process.platform === 'win32') return [];
    const listing = command('ps', ['-axo', 'pid=,command=']);
    const found = [];
    for (const line of listing.split('\n')) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!match || Number(match[1]) === process.pid || Number(match[1]) === process.ppid) continue;
        const kind = busyPatterns.find(({ pattern }) => pattern.test(match[2]));
        if (kind) found.push({ pid: Number(match[1]), kind: kind.name, command: match[2].slice(0, 160) });
    }
    return found;
}
