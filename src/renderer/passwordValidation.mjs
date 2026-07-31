/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function validateProjectPassword(password, confirmation = '', confirm = false, initialError = '') {
    if (!confirm) return { valid: Boolean(password), message: password ? '' : initialError };
    if (password.length < 12) {
        const remaining = 12 - password.length;
        return {
            valid: false,
            message: `Use at least 12 characters · ${remaining} more ${remaining === 1 ? 'character' : 'characters'}.`
        };
    }
    if (!confirmation) return { valid: false, message: 'Confirm your password.' };
    if (password !== confirmation) return { valid: false, message: 'The passwords do not match.' };
    return { valid: true, message: '' };
}
