import { readError, type BatchProvider, type RawSegment } from './types';

interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type: 'word' | 'spacing' | 'audio_event';
  speaker_id?: string;
}

/** Group word-level output into speaker turns. */
export function wordsToSegments(words: ScribeWord[]): RawSegment[] {
  const out: RawSegment[] = [];
  let lastEnd = 0;
  for (const w of words) {
    if (w.type === 'audio_event') continue;
    const speaker = w.speaker_id ?? 'speaker_0';
    const cur = out[out.length - 1];
    if (w.type === 'spacing') {
      if (cur) cur.text += w.text;
      continue;
    }
    if (!cur || cur.speaker !== speaker) {
      out.push({ start: w.start ?? lastEnd, end: w.end ?? w.start ?? lastEnd, speaker, text: w.text });
    } else {
      cur.text += w.text;
      cur.end = w.end ?? cur.end;
    }
    lastEnd = out[out.length - 1].end;
  }
  return out.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
}

/** ElevenLabs Scribe, batch endpoint. Swedish supported, diarization per request. */
export const elevenLabsProvider: BatchProvider = {
  kind: 'batch',
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe (batch)',
  speakerScope: 'chunk',
  maxFullFileSeconds: 8 * 3600,
  async transcribe(wav, _ctx, settings) {
    const form = new FormData();
    form.append('file', wav, 'chunk.wav');
    form.append('model_id', settings.model || 'scribe_v2');
    form.append('language_code', toIso3(settings.language));
    form.append('diarize', 'true');
    form.append('tag_audio_events', 'false');
    form.append('timestamps_granularity', 'word');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': settings.apiKey },
      body: form,
    });
    if (!res.ok) throw await readError(res);
    const data = (await res.json()) as { words?: ScribeWord[]; text?: string };
    if (data.words?.length) return wordsToSegments(data.words);
    return data.text ? [{ start: 0, end: 0, speaker: 'speaker_0', text: data.text }] : [];
  },
};

function toIso3(lang: string): string {
  const map: Record<string, string> = { sv: 'swe', en: 'eng', no: 'nor', da: 'dan', fi: 'fin', de: 'deu' };
  return map[lang] ?? lang;
}
