/* Copyright © 2026 Zenin Easa Panthakkalakath */

const minimizeButton = document.getElementById('minimizeButton');
const maximizeButton = document.getElementById('maximizeButton');
const maximizeIcon = document.getElementById('maximizeIcon');
const closeButton = document.getElementById('closeButton');

minimizeButton.addEventListener('click', () => {
    window.windowControls.minimize();
});

maximizeButton.addEventListener('click', () => {
    window.windowControls.toggleMaximize();
});

closeButton.addEventListener('click', () => {
    window.windowControls.close();
});

window.windowControls.onMaximizedChange((isMaximized) => {
    maximizeIcon.textContent = isMaximized ? '❐' : '□';
    maximizeButton.title = isMaximized ? 'Restore' : 'Maximize';
    maximizeButton.setAttribute(
        'aria-label',
        isMaximized ? 'Restore window' : 'Maximize window'
    );
});
