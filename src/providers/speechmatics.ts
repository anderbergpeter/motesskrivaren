import { ProviderError, readError, type RawSegment, type StreamProvider } from './types';

interface SmResult {
  type: 'word' | 'punctuation';
  start_time: number;
  end_time: number;
  alternatives?: Array<{ content: string; speaker?: string }>;
}
interface SmMessage {
  message: string;
  results?: SmResult[];
  reason?: string;
  type?: string;
}

/** Group Speechmatics words/punctuation into speaker turns (S1, S2 … persist for the session). */
export function smResultsToSegments(results: SmResult[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const r of results) {
    const alt = r.alternatives?.[0];
    if (!alt) continue;
    const speaker = alt.speaker ?? 'S1';
    const last = out[out.length - 1];
    if (r.type === 'punctuation') {
      if (last) {
        last.text += alt.content;
        last.end = r.end_time;
      }
      continue;
    }
    if (last && last.speaker === speaker) {
      last.text += ' ' + alt.content;
      last.end = r.end_time;
    } else {
      out.push({ start: r.start_time, end: r.end_time, speaker, text: alt.content });
    }
  }
  return out;
}

/**
 * Speechmatics real-time. Swedish supported, EU endpoint, speaker labels are
 * consistent for the whole WebSocket session. The browser first exchanges the
 * long-lived API key for a short-lived JWT, which is what the socket uses.
 */
export const speechmaticsProvider: StreamProvider = {
  kind: 'stream',
  id: 'speechmatics',
  label: 'Speechmatics realtid (EU, konsekventa talare)',
  speakerScope: 'session',
  async connect(settings, handlers) {
    const keyRes = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 * 4 }),
    });
    if (!keyRes.ok) throw await readError(keyRes);
    const { key_value } = (await keyRes.json()) as { key_value: string };

    const ws = new WebSocket(`wss://eu.rt.speechmatics.com/v2?jwt=${encodeURIComponent(key_value)}`);
    ws.binaryType = 'arraybuffer';
    let seq = 0;
    let closedResolve: (() => void) | null = null;
    const closed = new Promise<void>((r) => (closedResolve = r));

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            message: 'StartRecognition',
            audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
            transcription_config: {
              language: settings.language,
              operating_point: settings.model || 'enhanced',
              diarization: 'speaker',
              enable_partials: false,
              max_delay: 4,
              speaker_diarization_config: { prefer_current_speaker: true },
            },
          }),
        );
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as SmMessage;
        if (msg.message === 'RecognitionStarted') resolve();
        else if (msg.message === 'Error') reject(new ProviderError(`Speechmatics: ${msg.type ?? ''} ${msg.reason ?? ''}`, undefined, false));
      };
      ws.onerror = () => reject(new ProviderError('Kunde inte ansluta till Speechmatics', undefined, false));
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SmMessage;
        if (msg.message === 'AddTranscript' && msg.results?.length) handlers.onSegments(smResultsToSegments(msg.results));
        else if (msg.message === 'Error') handlers.onError(new ProviderError(`Speechmatics: ${msg.type ?? ''} ${msg.reason ?? ''}`));
        else if (msg.message === 'EndOfTranscript') ws.close(1000);
      } catch (e) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => handlers.onError(new ProviderError('Speechmatics-anslutningen fick ett fel'));
    ws.onclose = (ev) => {
      if (ev.code !== 1000) handlers.onError(new ProviderError(`Speechmatics stängde anslutningen (${ev.code})`));
      closedResolve?.();
    };

    return {
      sendPcm(samples) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(samples);
          seq += 1;
        }
      },
      async close() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: seq }));
        await Promise.race([closed, new Promise((r) => setTimeout(r, 15000))]);
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
      },
    };
  },
};
