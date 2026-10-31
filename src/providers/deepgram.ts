import { ProviderError, type RawSegment, type StreamProvider } from './types';

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

interface DgMessage {
  type: 'Results' | 'Metadata' | 'UtteranceEnd' | 'SpeechStarted' | 'Error';
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript: string; words?: DgWord[] }> };
  description?: string;
}

/** Group Deepgram words into speaker turns (session-consistent speaker ids). */
export function dgWordsToSegments(words: DgWord[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const w of words) {
    const speaker = String(w.speaker ?? 0);
    const text = w.punctuated_word ?? w.word;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ' ' + text;
      last.end = w.end;
    } else {
      out.push({ start: w.start, end: w.end, speaker, text });
    }
  }
  return out;
}

/**
 * Deepgram live WebSocket. Speaker labels persist for the whole connection,
 * which makes it the simplest way to get consistent "Talare A/B/C" live.
 */
export const deepgramProvider: StreamProvider = {
  kind: 'stream',
  id: 'deepgram',
  label: 'Deepgram live (realtid, konsekventa talare)',
  speakerScope: 'session',
  async connect(settings, handlers) {
    const params = new URLSearchParams({
      model: settings.model || 'nova-2',
      language: settings.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'false',
      endpointing: '300',
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', settings.apiKey]);
    ws.binaryType = 'arraybuffer';
    let closedResolve: (() => void) | null = null;
    const closed = new Promise<void>((r) => (closedResolve = r));
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        keepAlive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, 8000);
        resolve();
      };
      ws.onerror = () => reject(new ProviderError('Kunde inte ansluta till Deepgram (kontrollera API-nyckeln)', undefined, false));
    });

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as DgMessage;
        if (msg.type === 'Error') {
          handlers.onError(new ProviderError(msg.description ?? 'Deepgram-fel'));
          return;
        }
        if (msg.type !== 'Results' || !msg.is_final) return;
        const words = msg.channel?.alternatives?.[0]?.words ?? [];
        if (words.length) handlers.onSegments(dgWordsToSegments(words));
      } catch (e) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      }
    };
    ws.onerror = () => handlers.onError(new ProviderError('Deepgram-anslutningen fick ett fel'));
    ws.onclose = (ev) => {
      if (keepAlive) clearInterval(keepAlive);
      if (ev.code !== 1000) handlers.onError(new ProviderError(`Deepgram stängde anslutningen (${ev.code})`));
      closedResolve?.();
    };

    return {
      sendPcm(samples) {
        if (ws.readyState === WebSocket.OPEN) ws.send(samples);
      },
      async close() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
        await Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]);
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
      },
    };
  },
};
