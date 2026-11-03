/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The same path shapes packageArchive.mjs (which uses node:fs) checks an entry's image and screenshots against, for the page's registry
// code, which cannot import that file. A test holds the two in step.
export const registryImagePathPatternForWeb = /^images\/[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
export const registryScreenshotPathPatternForWeb = /^screenshots\/[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
export const registryVideoUrlPatternForWeb = /^https:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/;
