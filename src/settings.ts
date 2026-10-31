export type CloudKind = 'none' | 'google' | 'microsoft';

export interface Settings {
  providerId: string;
  /** API key per provider id, kept only in this browser. */
  apiKeys: Record<string, string>;
  selfHostedUrl: string;
  model: string;
  language: string;
  chunkSeconds: number;
  cloud: CloudKind;
  googleClientId: string;
  microsoftClientId: string;
  /** Also upload the raw audio chunks (needed for a later full-file pass on another device). */
  uploadAudio: boolean;
  /** Keep audio in this browser after the meeting (otherwise deleted when the transcript is synced). */
  keepLocalAudio: boolean;
}

const KEY = 'ms.settings';

export const defaultSettings: Settings = {
  providerId: 'mock',
  apiKeys: {},
  selfHostedUrl: '',
  model: '',
  language: 'sv',
  chunkSeconds: 60,
  cloud: 'none',
  googleClientId: '',
  microsoftClientId: '',
  uploadAudio: false,
  keepLocalAudio: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...parsed, apiKeys: { ...(parsed.apiKeys ?? {}) } };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
