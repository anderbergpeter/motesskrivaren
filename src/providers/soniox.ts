import { ProviderError, type RawSegment, type StreamProvider } from './types';

interface SonioxToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  is_final: boolean;
  speaker?: string | number;
}
interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

/** Group final Soniox tokens into speaker turns. Tokens are sub-word pieces that carry their own spacing. */
export function sonioxTokensToSegments(tokens: SonioxToken[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const t of tokens) {
    if (!t.is_final) continue;
    const speaker = String(t.speaker ?? '1');
    const start = (t.start_ms ?? 0) / 1000;
    const end = (t.end_ms ?? t.start_ms ?? 0) / 1000;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) {
      last.text += t.text;
      last.end = end;
    } else {
      out.push({ start, end, speaker, text: t.text });
    }
  }
  return out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

/**
 * Soniox real-time. Swedish + diarization bundled, cheap, EU endpoint on request.
 * The API key is sent in the first WebSocket message, so a temporary key
 * (POST /v1/auth/temporary-api-key) is preferable; we fetch one when possible
 * and fall back to the long-lived key.
 */
export const sonioxProvider: StreamProvider = {
  kind: 'stream',
  id: 'soniox',
  label: 'Soniox realtid (billig, konsekventa talare)',
  speakerScope: 'session',
  async connect(settings, handlers) {
    let apiKey = settings.apiKey;
    try {
      const r = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300 }),
      });
      if (r.ok) apiKey = ((await r.json()) as { api_key: string }).api_key;
    } catch {
      /* fall back to the long-lived key */
    }

    const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
    let closedResolve: (() => void) | null = null;
    const closed = new Promise<void>((r) => (closedResolve = r));

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            api_key: apiKey,
            model: settings.model || 'stt-rt-preview',
            audio_format: 'pcm_s16le',
            sample_rate: 16000,
            num_channels: 1,
            language_hints: [settings.language],
            enable_speaker_diarization: true,
          }),
        );
        resolve();
      };
      ws.onerror = () => reject(new ProviderError('Kunde inte ansluta till Soniox', undefined, false));
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SonioxMessage;
        if (msg.error_code) {
          handlers.onError(new ProviderError(`Soniox ${msg.error_code}: ${msg.error_message ?? ''}`));
          return;
        }
        if (msg.tokens?.length) {
          const segs = sonioxTokensToSegments(msg.tokens);
          if (segs.length) handlers.onSegments(segs);
        }
        if (msg.finished) ws.close(1000);
      } catch (e) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => handlers.onError(new ProviderError('Soniox-anslutningen fick ett fel'));
    ws.onclose = (ev) => {
      if (ev.code !== 1000 && ev.code !== 1005) handlers.onError(new ProviderError(`Soniox stängde anslutningen (${ev.code})`));
      closedResolve?.();
    };

    return {
      sendPcm(samples) {
        if (ws.readyState === WebSocket.OPEN) ws.send(samples);
      },
      async close() {
        if (ws.readyState === WebSocket.OPEN) ws.send(''); // empty frame = end of audio
        await Promise.race([closed, new Promise((r) => setTimeout(r, 15000))]);
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
      },
    };
  },
};
