import { PublicClientApplication, type AccountInfo } from '@azure/msal-browser';
import { CloudAuthError, type CloudStorage } from './types';

const SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * OneDrive (personal or work/school) via MSAL + Graph "app folder".
 * Files land in OneDrive/Appar/Mötesskrivaren, visible only to the user.
 */
export class OneDriveStorage implements CloudStorage {
  kind = 'microsoft' as const;
  label = 'OneDrive';
  private app: PublicClientApplication | null = null;
  private account: AccountInfo | null = null;

  constructor(private readonly clientId: string) {}

  private async msal(): Promise<PublicClientApplication> {
    if (!this.clientId) throw new CloudAuthError('Ange Microsoft Entra Application (client) ID i inställningarna');
    if (!this.app) {
      this.app = new PublicClientApplication({
        auth: { clientId: this.clientId, authority: 'https://login.microsoftonline.com/common', redirectUri: window.location.origin + window.location.pathname },
        cache: { cacheLocation: 'localStorage' },
      });
      await this.app.initialize();
      const result = await this.app.handleRedirectPromise().catch(() => null);
      this.account = result?.account ?? this.app.getAllAccounts()[0] ?? null;
    }
    return this.app;
  }

  isConnected(): boolean {
    return !!this.account;
  }

  accountLabel(): string | null {
    return this.account?.username ?? null;
  }

  async connect(): Promise<void> {
    const app = await this.msal();
    const result = await app.loginPopup({ scopes: SCOPES });
    this.account = result.account;
  }

  async disconnect(): Promise<void> {
    const app = await this.msal();
    const account = this.account;
    this.account = null;
    if (account) await app.logoutPopup({ account }).catch(() => undefined);
  }

  /** Call once at startup so a previous login is picked up without a popup. */
  async restore(): Promise<void> {
    await this.msal().catch(() => undefined);
  }

  private async token(): Promise<string> {
    const app = await this.msal();
    if (!this.account) throw new CloudAuthError('Inte inloggad på Microsoft');
    try {
      const r = await app.acquireTokenSilent({ scopes: SCOPES, account: this.account });
      return r.accessToken;
    } catch {
      const r = await app.acquireTokenPopup({ scopes: SCOPES, account: this.account });
      return r.accessToken;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    const res = await fetch(`${GRAPH}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (res.status === 401) throw new CloudAuthError('Microsoft-inloggningen har gått ut, logga in igen');
    if (!res.ok) throw new Error(`OneDrive HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async ensureRootFolder(): Promise<string> {
    // The app folder itself is the root: OneDrive/Appar/<app name>.
    const root = await this.request<{ id: string }>('/me/drive/special/approot');
    return root.id;
  }

  async ensureFolder(parentId: string, name: string): Promise<string> {
    const children = await this.request<{ value: Array<{ id: string; name: string; folder?: unknown }> }>(
      `/me/drive/items/${parentId}/children?$select=id,name,folder&$filter=${encodeURIComponent(`name eq '${name.replace(/'/g, "''")}'`)}`,
    ).catch(() => ({ value: [] }));
    const hit = children.value.find((c) => c.folder && c.name === name);
    if (hit) return hit.id;
    const created = await this.request<{ id: string }>(`/me/drive/items/${parentId}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }),
    });
    return created.id;
  }

  async putText(folderId: string, name: string, content: string, existingId?: string): Promise<string> {
    const body = new Blob([content], { type: 'text/markdown; charset=utf-8' });
    const path = existingId
      ? `/me/drive/items/${existingId}/content`
      : `/me/drive/items/${folderId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`;
    const item = await this.request<{ id: string }>(path, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body });
    return item.id;
  }

  async putBlob(folderId: string, name: string, blob: Blob): Promise<string> {
    if (blob.size > 4 * 1024 * 1024) return this.uploadLarge(folderId, name, blob);
    const item = await this.request<{ id: string }>(
      `/me/drive/items/${folderId}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`,
      { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob },
    );
    return item.id;
  }

  private async uploadLarge(folderId: string, name: string, blob: Blob): Promise<string> {
    const session = await this.request<{ uploadUrl: string }>(
      `/me/drive/items/${folderId}:/${encodeURIComponent(name)}:/createUploadSession`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name } }),
      },
    );
    const step = 10 * 320 * 1024; // 3.2 MiB, a multiple of 320 KiB as Graph requires
    let id = '';
    for (let offset = 0; offset < blob.size; offset += step) {
      const end = Math.min(offset + step, blob.size);
      const res = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`, 'Content-Length': String(end - offset) },
        body: blob.slice(offset, end),
      });
      if (!res.ok) throw new Error(`OneDrive upload HTTP ${res.status}`);
      if (res.status === 200 || res.status === 201) id = ((await res.json()) as { id: string }).id;
    }
    return id;
  }
}
