// Keep the original state/summary store, but isolate the takeover preference.
import { getSTContext, deepMerge } from './utils.js';
import { DEFAULT_CONFIG, EXTENSION_ID } from './constants.js';
export const CONFIG_ID = 'save-original-minimal';

export function loadConfig() {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const ctx = getSTContext();
  const own = ctx?.extensionSettings?.[CONFIG_ID]?.config;
  if (own && typeof own === 'object') return deepMerge(defaults, own);

  // Preserve other original preferences without inheriting "original disabled".
  const original = ctx?.extensionSettings?.[EXTENSION_ID]?.config;
  if (!original || typeof original !== 'object') return defaults;
  const inherited = JSON.parse(JSON.stringify(original));
  delete inherited.enabled;
  return deepMerge(defaults, inherited);
}

export function saveConfig(config) {
  const ctx = getSTContext();
  if (!ctx) return;
  ctx.extensionSettings ??= {};
  ctx.extensionSettings[CONFIG_ID] ??= {};
  ctx.extensionSettings[CONFIG_ID].config = config;
  ctx.extensionSettings[CONFIG_ID].enabled = config.enabled;
  ctx.saveSettingsDebounced?.();
}
