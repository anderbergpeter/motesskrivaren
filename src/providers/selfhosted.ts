import { readError, type BatchProvider, type RawSegment } from './types';

/**
 * Your own server (see /server in this repo): KB-Whisper + pyannote with
 * speaker tracking across chunks, so labels are consistent for the session.
 *
 * Contract: POST {baseUrl}/v1/transcribe  multipart: file=<wav>, session_id, chunk_index, language
 *           -> { "segments": [{ "start", "end", "speaker", "text" }] }
 */
export const selfHostedProvider: BatchProvider = {
  kind: 'batch',
  id: 'selfhosted',
  label: 'Egen server (KB-Whisper + pyannote)',
  speakerScope: 'session',
  maxFullFileSeconds: 4 * 3600,
  async transcribe(wav, ctx, settings) {
    const base = (settings.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('Ange serverns adress i inställningarna');
    const form = new FormData();
    form.append('file', wav, `chunk-${ctx.chunkIndex}.wav`);
    form.append('session_id', ctx.sessionId);
    form.append('chunk_index', String(ctx.chunkIndex));
    form.append('language', settings.language);
    const headers: Record<string, string> = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const res = await fetch(`${base}/v1/transcribe`, { method: 'POST', headers, body: form });
    if (!res.ok) throw await readError(res);
    const data = (await res.json()) as { segments: RawSegment[] };
    return data.segments ?? [];
  },
};
