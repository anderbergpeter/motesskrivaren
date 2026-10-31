import { describe, expect, it } from 'vitest';
import { dgWordsToSegments } from './deepgram';
import { wordsToSegments } from './elevenlabs';

describe('ElevenLabs word grouping', () => {
  it('groups words by speaker and keeps spacing', () => {
    const segs = wordsToSegments([
      { text: 'Hej', start: 0, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', type: 'spacing' },
      { text: 'alla.', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', type: 'spacing' },
      { text: '(skratt)', start: 1, end: 1.5, type: 'audio_event' },
      { text: 'Hej.', start: 1.6, end: 2, type: 'word', speaker_id: 'speaker_1' },
    ]);
    expect(segs).toEqual([
      { start: 0, end: 0.9, speaker: 'speaker_0', text: 'Hej alla.' },
      { start: 1.6, end: 2, speaker: 'speaker_1', text: 'Hej.' },
    ]);
  });
});

describe('Deepgram word grouping', () => {
  it('uses punctuated words and numeric speakers', () => {
    const segs = dgWordsToSegments([
      { word: 'vi', punctuated_word: 'Vi', start: 0, end: 0.2, speaker: 1 },
      { word: 'börjar', punctuated_word: 'börjar.', start: 0.2, end: 0.6, speaker: 1 },
      { word: 'ok', punctuated_word: 'Ok.', start: 1, end: 1.2, speaker: 0 },
    ]);
    expect(segs).toEqual([
      { start: 0, end: 0.6, speaker: '1', text: 'Vi börjar.' },
      { start: 1, end: 1.2, speaker: '0', text: 'Ok.' },
    ]);
  });
});
