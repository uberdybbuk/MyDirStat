/** Number and date formatting shared across the three panes. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Binary units, matching du and WinDirStat rather than Finder. */
export function bytes(n: number): string {
    if (!n) return '0 B';
    const sign = n < 0 ? '-' : '';
    let value = Math.abs(n);
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${sign}${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function count(n: number): string {
    return (n || 0).toLocaleString();
}

export function percent(fraction: number): string {
    if (fraction >= 0.1) return `${(fraction * 100).toFixed(1)}%`;
    return fraction > 0 ? `${(fraction * 100).toFixed(2)}%` : '';
}

export function when(ms: number): string {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
