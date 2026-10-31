import { readError, type BatchProvider, type RawSegment } from './types';

interface DiarizedSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * OpenAI gpt-4o-transcribe-diarize (batch). Speaker labels are per request,
 * so a full-file pass is what gives consistent speakers.
 */
export const openAiProvider: BatchProvider = {
  kind: 'batch',
  id: 'openai',
  label: 'OpenAI gpt-4o-transcribe-diarize (batch)',
  speakerScope: 'chunk',
  // 25 MB upload limit: ~13 min of 16 kHz WAV. Full-file pass not possible.
  maxFullFileSeconds: 0,
  async transcribe(wav, _ctx, settings) {
    const form = new FormData();
    form.append('file', wav, 'chunk.wav');
    form.append('model', settings.model || 'gpt-4o-transcribe-diarize');
    form.append('language', settings.language);
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: form,
    });
    if (!res.ok) throw await readError(res);
    const data = (await res.json()) as { segments?: DiarizedSegment[]; text?: string };
    const segs: RawSegment[] = (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      speaker: s.speaker,
      text: s.text,
    }));
    if (segs.length === 0 && data.text) segs.push({ start: 0, end: 0, speaker: 'A', text: data.text });
    return segs;
  },
};
