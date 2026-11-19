/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Drive with two joysticks" (docs/proposals/tutorials.md), starting from the Excavator example: two joysticks (or one gamepad's two
// sticks) connected, their four axes bound in Settings › Controllers to the excavator's four live commands in the usual operator layout
// (left joystick: swing left and right, stick forward and back; right joystick: boom forward and back, bucket left and right), an online
// run in real time, and a dig: the bucket's tip brought down to the ground and lifted above 3 m. Every movement of the sticks is recorded
// with the result. With no joystick at hand, skipping the first step binds four pairs of keys instead, and skipping the dig has the
// excavator do it by itself. Steering needs a run that takes commands while it goes, so this tutorial is for the desktop app.

export const driveWithJoysticksValues = Object.freeze({
    // Which joystick and axis drives which command: joystick 0 is the left one, 1 the right; axis 0 is left and right, 1 forward and back.
    // One gamepad stands for both joysticks: its left stick is axes 0 and 1, its right stick 2 and 3. In the model's order, which is the
    // order Settings › Controllers lists them in and Bind goes through them in.
    commands: [
        { symbol: 'swingCommand', name: 'Swing command', joystick: 0, axis: 0, move: 'the left joystick left or right', keys: { up: 'KeyD', down: 'KeyA' } },
        { symbol: 'boomCommand', name: 'Boom command', joystick: 1, axis: 1, move: 'the right joystick forward or back', keys: { up: 'KeyK', down: 'KeyI' } },
        { symbol: 'stickCommand', name: 'Stick command', joystick: 0, axis: 1, move: 'the left joystick forward or back', keys: { up: 'KeyS', down: 'KeyW' } },
        { symbol: 'bucketCommand', name: 'Bucket command', joystick: 1, axis: 0, move: 'the right joystick left or right', keys: { up: 'KeyL', down: 'KeyJ' } }
    ],
    tip: 'Bucket tip',
    ground: 0,
    lift: 3,
    runSeconds: 60
});
const values = driveWithJoysticksValues;

const bound = (ui, symbols) => symbols.every((symbol) => ui.bindings.some((binding) => binding.symbol === symbol));
const allBound = (ui) => bound(ui, values.commands.map((command) => command.symbol));
const nextUnbound = (ui) => values.commands.find((command) => !bound(ui, [command.symbol])) ?? null;
// The tip touched the ground, and after that was lifted above the lift height.
const dug = (ui) => {
    const heights = ui.resultSeries(values.tip, 'height');
    const touched = heights.findIndex((height) => height <= values.ground);
    return touched >= 0 && heights.slice(touched).some((height) => height >= values.lift);
};

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Drive with two joysticks',
        text: 'This excavator has four functions, each a joint whose speed follows a command from −1 to 1: the cab\'s swing, the boom, the stick and the bucket. Operators drive one with two joysticks, two functions on each. You will bind the joysticks\' four axes to the four commands and dig, in real time.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'connect',
        title: 'Connect the joysticks',
        text: 'Plug in two joysticks, or one gamepad (its two sticks do as well), and press a button on each so Konjugate sees it: a browser shows a controller only once it has been used. Settings › Controllers draws every one it sees, its sticks and buttons moving as you move them, and "Not seeing your controller?" says how to connect one. No joystick at hand? Skip this step, and the four functions are bound to keys instead: A and D swing, W and S the stick, I and K the boom, J and L the bucket.',
        target: (ui) => (ui.controllersShown ? '#controllerDevices' : ui.settingsOpen ? '[data-settings-target="controllers"]' : '#settingsButton'),
        status: (ui) => (ui.gamepadNames.length
            ? `Konjugate sees ${ui.gamepadNames.length === 1 ? 'one controller' : `${ui.gamepadNames.length} controllers`} (${ui.gamepadNames.join(', ')}), with ${ui.gamepadAxes} ${ui.gamepadAxes === 1 ? 'axis' : 'axes'} in all${ui.gamepadAxes >= 4 ? '.' : ui.controllersNotSeen?.length ? `: four are needed, and ${ui.controllersNotSeen.join(' and ')} is connected too, so press one of its buttons.` : ': four are needed, so connect the second joystick.'}`
            : ui.controllersNotSeen?.length
                ? `This computer has ${ui.controllersNotSeen.join(' and ')} connected: press one of its buttons while Konjugate is in front.`
                : 'Konjugate sees no joystick or gamepad yet.'),
        link: { label: 'Not seeing your controller?', action: 'showControllerHelp' },
        skip: 'bindKeyboardFallback', commands: values.commands,
        // Four axes in all: two joysticks, or one gamepad with two sticks.
        done: ({ ui }) => ui.gamepadAxes >= 4 || allBound(ui)
    },
    {
        id: 'bind',
        title: 'Bind the four commands',
        text: 'In Settings › Controllers, press Bind beside "Swing command" and move the left joystick left or right. Konjugate then listens for the next command by itself: move the boom with the right joystick forward or back, the stick with the left joystick forward or back, and the bucket with the right joystick left or right. With one gamepad, its left stick is the left joystick and its right stick the right one. A centred joystick sends 0, holding its joint still. If a function moves the wrong way, press Invert on its row; Rebind gives it another control.',
        target: (ui) => {
            const next = nextUnbound(ui);
            if (!ui.controllersShown) return ui.settingsOpen ? '[data-settings-target="controllers"]' : '#settingsButton';
            if (!next) return '#controllerParameters';
            return ui.controllerListeningFor === next.symbol ? `.controllerParameter[data-symbol="${next.symbol}"]` : `[data-bind-symbol="${next.symbol}"]`;
        },
        status: (ui) => {
            const next = nextUnbound(ui);
            if (!next) return '';
            const done = values.commands.filter((command) => bound(ui, [command.symbol])).length;
            const progress = done ? `${done} of ${values.commands.length} bound. ` : '';
            return ui.controllerListeningFor === next.symbol
                ? `${progress}Listening for ${next.name}: move ${next.move}.`
                : `${progress}Next: ${next.name}, with ${next.move}. Press Bind beside it.`;
        },
        skip: 'bindJoystickAxes', commands: values.commands,
        done: ({ ui }) => allBound(ui)
    },
    {
        id: 'startRun',
        title: 'Start a run in real time',
        text: `Close Settings and press Run. Turn on "Online", set the pacing to "Real time", set "Run until" to ${values.runSeconds} s, and press Start. The joysticks drive the excavator for as long as it runs.`,
        target: (ui) => (ui.settingsOpen ? '#settingsClose' : ui.runDialogOpen ? '#runOnlineMode' : '#runButton'), skip: 'startOnlineRun', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.steerable || dug(ui)
    },
    {
        id: 'dig',
        title: 'Dig',
        text: `Watch the ${values.tip}'s height on the canvas. Push the right joystick forward to lower the boom, and work the left one to reach out, until the tip touches the ground (a height of 0 m). Then pull the boom back up and curl the bucket until the tip is above ${values.lift} m. Each function keeps moving while its stick is held and stops when it is let go.`,
        target: (ui) => ui.labelOf(values.tip), skip: 'digByItself', dig: { ground: values.ground, lift: values.lift },
        done: ({ ui }) => dug(ui)
    },
    {
        id: 'record',
        title: 'Every movement is recorded',
        text: 'The Changes panel opened beside the timeline as you drove: every movement of the sticks is there, by its size and when it was made. Once the run has ended, "Repeat from the record" plays it again exactly, to show what you did or to try the same driving on a changed model.',
        advance: 'next', done: () => true
    },
    {
        id: 'finish',
        title: 'You have driven a machine with two joysticks',
        text: 'A binding\'s Change… sets how its axis maps: inverted, or with a curve that is finer near the centre for careful work. Buttons can step a value or hold it while pressed, and MIDI controllers bind the same way. The four bindings stay in Settings › Controllers, for any model with these commands; remove them there if you do not want them.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const driveWithJoysticks = Object.freeze({
    id: 'driveWithJoysticks',
    title: 'Drive with two joysticks',
    summary: 'Bind two joysticks\' four axes to an excavator\'s swing, boom, stick and bucket, and dig in real time.',
    minutes: 5,
    area: 'control',
    tags: ['joystick', 'joysticks', 'gamepad', 'controller', 'analog', 'axis', 'sticks', 'keyboard', 'binding', 'steer', 'excavator', 'real time', 'human in the loop', 'operator'],
    start: { from: 'example', example: 'excavator.kjt' },
    editions: ['desktop'],
    inputDevices: true,
    steps
});
