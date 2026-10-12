export type TextSize = 'extra-small' | 'compact' | 'small' | 'standard' | 'large' | 'extra-large';
export type ThemeMode = 'light' | 'dark' | 'system';
export interface AppearancePreferences {textSize: TextSize; theme: ThemeMode; accent: string}
export type SharedAppearancePreferences = Pick<AppearancePreferences, 'accent'>;
/** Legacy device preferences remain readable for checksum verification, but are never applied. */
export type BackupAppearancePreferences = SharedAppearancePreferences & {theme?: ThemeMode; textSize?: TextSize};
export const TEXT_SIZE_IDS: TextSize[] = ['extra-small', 'compact', 'small', 'standard', 'large', 'extra-large'];
export const DEFAULT_APPEARANCE: AppearancePreferences = {textSize: 'standard', theme: 'light', accent: '#31584b'};
export const ACCENT_COLORS = [
  {color: '#31584b', label: '綠色'}, {color: '#3264ad', label: '藍色'},
  {color: '#7951b0', label: '紫色'}, {color: '#b56326', label: '橙色'}
];
export const PRESET_COLORS: Record<string, string> = {violet: '#9b83c8', blue: '#759acb', green: '#89a882', orange: '#d4a06d', pink: '#cf8fa8', gray: '#929992'};

export function validHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function validColor(value: unknown): value is string {
  return validHex(value) || (typeof value === 'string' && Object.hasOwn(PRESET_COLORS, value));
}

export function colorHex(value: string): string { return Object.hasOwn(PRESET_COLORS, value) ? PRESET_COLORS[value] : validHex(value) ? value.toLowerCase() : PRESET_COLORS['gray']; }

/** Read only supported fields; old text-only preferences receive the original light theme. */
export function readAppearance(value: unknown): AppearancePreferences | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<AppearancePreferences>;
  if (!TEXT_SIZE_IDS.includes(source.textSize as TextSize)
    || (source.theme !== undefined && !['light', 'dark', 'system'].includes(source.theme))
    || (source.accent !== undefined && !validHex(source.accent))) return null;
  return {textSize: source.textSize!, theme: source.theme ?? DEFAULT_APPEARANCE.theme, accent: (source.accent ?? DEFAULT_APPEARANCE.accent).toLowerCase()};
}

export function sharedAppearance(value: SharedAppearancePreferences): SharedAppearancePreferences {
  return {accent: value.accent};
}

export function readBackupAppearance(value: unknown): BackupAppearancePreferences | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<AppearancePreferences>;
  const preferences = readAppearance({...source, textSize: source.textSize ?? DEFAULT_APPEARANCE.textSize});
  if (!preferences || (source.textSize !== undefined && !TEXT_SIZE_IDS.includes(source.textSize))) return null;
  return {...sharedAppearance(preferences), ...(source.theme !== undefined ? {theme: preferences.theme} : {}), ...(source.textSize !== undefined ? {textSize: source.textSize} : {})};
}

function rgb(hex: string): number[] { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)); }
function hex(channels: number[]): string { return '#' + channels.map(value => Math.round(value).toString(16).padStart(2, '0')).join(''); }
export function mixColor(first: string, second: string, weight: number): string {
  const other = rgb(second);
  return hex(rgb(first).map((value, index) => value * weight + other[index] * (1 - weight)));
}
export function contrast(first: string, second: string): number {
  const luminance = (color: string) => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const left = luminance(first), right = luminance(second);
  return (Math.max(left, right) + .05) / (Math.min(left, right) + .05);
}
export function readableColor(color: string, background: string, minimum = 4.5): string {
  if (contrast(color, background) >= minimum) return color;
  const target = contrast('#000000', background) > contrast('#ffffff', background) ? '#000000' : '#ffffff';
  for (let step = 1; step <= 20; step++) {
    const adjusted = mixColor(color, target, 1 - step / 20);
    if (contrast(adjusted, background) >= minimum) return adjusted;
  }
  return target;
}
export function categoryPalette(value: string, dark: boolean): {color: string; background: string; text: string; onColor: string} {
  const original = colorHex(value);
  const surface = dark ? '#1e242a' : '#ffffff';
  const background = mixColor(original, surface, dark ? .2 : .13);
  const color = readableColor(original, surface, 3);
  return {color, background, text: readableColor(original, background), onColor: contrast('#ffffff', color) >= contrast('#000000', color) ? '#ffffff' : '#000000'};
}
export function themeTokens(accent: string, dark: boolean): Record<string, string> {
  const surface = dark ? '#1e242a' : '#ffffff';
  // Give even white, black and very pale accents a visible tint on the chosen surface.
  const tint = readableColor(accent, surface, 3);
  const background = (lightWeight: number, darkWeight: number) => mixColor(tint, surface, dark ? darkWeight : lightWeight);
  const backgrounds = {
    '--surface': surface, '--page': dark ? '#161b20' : '#ffffff',
    '--surface-soft': background(.045, .10), '--surface-hover': background(.14, .24),
    '--sidebar-bg': background(.105, .16), '--section-bg': background(.055, .12),
    '--control-bg': background(.075, .14), '--header-bg': background(.095, .18),
    '--footer-bg': background(.065, .12), '--calendar-outside-bg': background(.065, .10),
    '--calendar-weekend-bg': background(.025, .055), '--calendar-today-bg': background(.17, .28),
    '--accent-soft': background(.125, .24)
  };
  // Use the most demanding tinted surface so shared text stays readable in every region.
  const target = dark ? '#ffffff' : '#000000';
  const textBackground = Object.values(backgrounds).reduce((current, value) => contrast(target, value) < contrast(target, current) ? value : current, surface);
  const text = readableColor(dark ? '#e8edf2' : '#30383c', textBackground);
  const muted = readableColor(mixColor(tint, dark ? '#b2becb' : '#606b75', .15), textBackground);
  const soft = readableColor(mixColor(tint, dark ? '#98a7b7' : '#6b7480', .12), textBackground);
  const border = background(.17, .28);
  const strong = readableColor(accent, surface);
  return {
    ...backgrounds, '--text': text, '--text-muted': muted, '--text-soft': soft,
    '--border': border, '--accent': accent, '--accent-strong': strong,
    '--accent-text': readableColor(accent, textBackground), '--accent-border': background(.4, .52),
    '--on-accent': contrast('#ffffff', strong) >= contrast('#000000', strong) ? '#ffffff' : '#000000',
    '--danger-text': dark ? '#f1b4a7' : '#9c4333', '--danger-bg': dark ? '#392725' : '#fff1ed',
    '--danger-border': dark ? '#825148' : '#e5c7b9', '--warning-text': dark ? '#eac38f' : '#936229',
    '--warning-bg': dark ? '#332d23' : '#fff7e9', '--warning-border': dark ? '#776245' : '#ecd9c4',
    '--ink': text, '--muted': soft, '--line': border,
    '--green': strong, '--shadow-rgb': '0 0 0'
  };
}
