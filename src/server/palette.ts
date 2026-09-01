/**
 * Extension colours.
 *
 * Extensions arrive already ranked by total size (see NodeStore.summarise), so
 * colour is assigned by rank: the biggest type gets the first hue and stays
 * visually anchored across rescans. Everything past the palette collapses into
 * one grey, as WinDirStat folds its long tail into "<Files>".
 *
 * Base tones sit mid-luminance on purpose. The treemap multiplies them by a
 * cushion shading factor running well above and below 1.0, so a colour that
 * starts near black or near white loses all of its modelling.
 */

import type { SpecialColors } from '../shared/protocol.js';

export const PALETTE: readonly string[] = [
    '#4a86d8', // blue
    '#e0603c', // vermilion
    '#4fb783', // green
    '#e0a72e', // amber
    '#8a63c4', // purple
    '#3fb2c9', // cyan
    '#d9628f', // rose
    '#8aa832', // olive
    '#e07f3c', // orange
    '#5f6fd0', // indigo
    '#2f9e8f', // teal
    '#b5568f', // magenta
    '#9c7a4a', // tan
    '#6ba8e0', // sky
    '#c0524f', // brick
    '#5a9c5a', // moss
];

export const DIR_COLOR = '#6b7280'; // directory with no dominant type
export const OTHER_COLOR = '#8b9096'; // long tail past the palette
export const UNREADABLE_COLOR = '#54585e'; // permission denied, skipped mounts

export const SPECIAL_COLORS: SpecialColors = {
    dir: DIR_COLOR,
    other: OTHER_COLOR,
    unreadable: UNREADABLE_COLOR,
};

export function colorForRank(rank: number): string {
    if (rank < 0) return DIR_COLOR;
    return rank < PALETTE.length ? PALETTE[rank] : OTHER_COLOR;
}

/** Label shown in the extension legend. */
export function extensionLabel(ext: string): string {
    return ext === '' ? '<no extension>' : ext;
}
