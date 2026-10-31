import { ProviderError, type RawSegment, type StreamProvider } from './types';

/* Minimal typings: the Web Speech API is not in lib.dom for all targets. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const LANG: Record<string, string> = { sv: 'sv-SE', en: 'en-US', no: 'nb-NO', da: 'da-DK', fi: 'fi-FI', de: 'de-DE' };

/**
 * The browser's own speech recognition (Google on Android/Chrome, Apple on
 * Safari). Free and instant, but no speaker labels and no word timing; the
 * app timestamps each final result with the wall clock.
 */
export const webSpeechProvider: StreamProvider = {
  kind: 'stream',
  id: 'webspeech',
  label: 'Webbläsarens taligenkänning (gratis, utan talare)',
  speakerScope: 'session',
  async connect(settings, handlers) {
    const Ctor = getCtor();
    if (!Ctor) throw new ProviderError('Den här webbläsaren saknar inbyggd taligenkänning (prova Chrome eller Safari)', undefined, false);
    const startedAt = performance.now();
    let lastEnd = 0;
    let stopped = false;
    let rec: SpeechRecognitionLike | null = null;

    const spawn = () => {
      const r = new Ctor();
      r.lang = LANG[settings.language] ?? settings.language;
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (ev) => {
        const segs: RawSegment[] = [];
        const now = (performance.now() - startedAt) / 1000;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (!res.isFinal) continue;
          const text = res[0].transcript.trim();
          if (!text) continue;
          segs.push({ start: lastEnd, end: now, speaker: '0', text });
          lastEnd = now;
        }
        if (segs.length) handlers.onSegments(segs);
      };
      r.onerror = (ev) => {
        if (ev.error === 'no-speech' || ev.error === 'aborted') return;
        handlers.onError(new ProviderError(`Taligenkänning: ${ev.error}`));
      };
      // Browsers end continuous sessions after a while; restart until we are told to stop.
      r.onend = () => {
        if (!stopped) {
          try {
            spawn();
          } catch (e) {
            handlers.onError(e instanceof Error ? e : new Error(String(e)));
          }
        }
      };
      r.start();
      rec = r;
    };
    spawn();

    return {
      sendPcm() {
        /* The browser captures the microphone itself. */
      },
      async close() {
        stopped = true;
        rec?.stop();
        await new Promise((r) => setTimeout(r, 1500));
      },
    };
  },
};
