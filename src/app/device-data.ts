import type { DeviceIdentity } from './models.ts';

export const DEVICE_STORAGE_KEY = 'orbit-device-v1';
export const DEVICE_NAME_LIMIT = 60;

export function readDeviceIdentity(value: unknown): DeviceIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const device = value as DeviceIdentity;
  return typeof device.id === 'string' && !!device.id && device.id.length <= 100
    && typeof device.name === 'string' && !!device.name.trim() && device.name.length <= DEVICE_NAME_LIMIT
    ? {id: device.id, name: device.name} : null;
}

/** Kept outside exported/synced state so another device never replaces this identity. */
export function loadDeviceIdentity(fallback?: DeviceIdentity): DeviceIdentity {
  try {
    const saved = readDeviceIdentity(JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) ?? 'null'));
    if (saved) return saved;
  } catch { /* A blocked store still allows editing in this page. */ }
  const id = fallback?.id ?? crypto.randomUUID();
  const identity = fallback ?? {id, name: '裝置 ' + id.slice(0, 6)};
  try {localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity));} catch { /* Saving the name reports persistence failure separately. */ }
  return identity;
}
