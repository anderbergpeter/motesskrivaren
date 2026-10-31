import { CloudAuthError, ROOT_FOLDER_NAME, type CloudStorage } from './types';

/** Minimal typing for Google Identity Services token client. */
interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string }) => void;
          }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const STORAGE_KEY = 'ms.google.token';

interface StoredToken {
  token: string;
  expiresAt: number;
  email?: string;
}

let gisLoaded: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts) return Promise.resolve();
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Kunde inte ladda Google Identity Services'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

export class GoogleDriveStorage implements CloudStorage {
  kind = 'google' as const;
  label = 'Google Drive';
  private client: TokenClient | null = null;
  private pending: { resolve: (t: TokenResponse) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly clientId: string) {}

  private stored(): StoredToken | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoredToken) : null;
    } catch {
      return null;
    }
  }

  isConnected(): boolean {
    const t = this.stored();
    return !!t && t.expiresAt > Date.now() + 60_000;
  }

  accountLabel(): string | null {
    return this.stored()?.email ?? (this.stored() ? 'Google-konto' : null);
  }

  /** Seconds until the access token expires (Google tokens last ~1 h, no silent refresh on static sites). */
  secondsLeft(): number {
    const t = this.stored();
    return t ? Math.max(0, Math.floor((t.expiresAt - Date.now()) / 1000)) : 0;
  }

  async connect(): Promise<void> {
    if (!this.clientId) throw new CloudAuthError('Ange Google OAuth Client ID i inställningarna');
    await loadGis();
    if (!this.client) {
      this.client = window.google!.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (r) => {
          const p = this.pending;
          this.pending = null;
          if (r.error || !r.access_token) p?.reject(new CloudAuthError(`Google-inloggning misslyckades: ${r.error ?? 'okänt fel'}`));
          else p?.resolve(r);
        },
        error_callback: (e) => {
          const p = this.pending;
          this.pending = null;
          p?.reject(new CloudAuthError(`Google-inloggning avbröts (${e.type})`));
        },
      });
    }
    const r = await new Promise<TokenResponse>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.client!.requestAccessToken({ prompt: this.stored() ? '' : 'consent' });
    });
    const token: StoredToken = { token: r.access_token!, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
    try {
      const me = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: this.headers() }).then((x) => x.json());
      token.email = me?.user?.emailAddress;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
    } catch {
      /* label only */
    }
  }

  async disconnect(): Promise<void> {
    const t = this.stored();
    localStorage.removeItem(STORAGE_KEY);
    if (t && window.google?.accounts) window.google.accounts.oauth2.revoke(t.token);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const t = this.stored();
    if (!t || t.expiresAt <= Date.now()) throw new CloudAuthError('Google-inloggningen har gått ut, logga in igen');
    return { Authorization: `Bearer ${t.token}`, ...extra };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (res.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      throw new CloudAuthError('Google-inloggningen har gått ut, logga in igen');
    }
    if (!res.ok) throw new Error(`Google Drive HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  private async findChild(parentId: string, name: string, folder: boolean): Promise<string | null> {
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
      'trashed = false',
      folder ? "mimeType = 'application/vnd.google-apps.folder'" : "mimeType != 'application/vnd.google-apps.folder'",
    ].join(' and ');
    const data = await this.request<{ files: Array<{ id: string }> }>(
      `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
      { headers: this.headers() },
    );
    return data.files[0]?.id ?? null;
  }

  async ensureRootFolder(): Promise<string> {
    return this.ensureFolder('root', ROOT_FOLDER_NAME);
  }

  async ensureFolder(parentId: string, name: string): Promise<string> {
    const existing = await this.findChild(parentId, name, true);
    if (existing) return existing;
    const created = await this.request<{ id: string }>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    return created.id;
  }

  async putText(folderId: string, name: string, content: string, existingId?: string): Promise<string> {
    const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' });
    if (existingId) {
      await this.request(`${UPLOAD}/files/${existingId}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: this.headers({ 'Content-Type': 'text/markdown' }),
        body: blob,
      });
      return existingId;
    }
    return this.multipartCreate(folderId, name, blob);
  }

  async putBlob(folderId: string, name: string, blob: Blob): Promise<string> {
    return this.multipartCreate(folderId, name, blob);
  }

  private async multipartCreate(folderId: string, name: string, blob: Blob): Promise<string> {
    const boundary = 'motesskrivaren_' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [folderId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const created = await this.request<{ id: string }>(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': `multipart/related; boundary=${boundary}` }),
      body,
    });
    return created.id;
  }
}
