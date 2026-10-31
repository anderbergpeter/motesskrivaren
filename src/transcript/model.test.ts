import { describe, expect, it } from 'vitest';
import { defaultSpeakerNames, paragraphs, sessionFileName, speakerKey, toMarkdown, type Session } from './model';

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Veckomöte',
    startedAt: '2026-10-31T09:05:00',
    chunkSeconds: 60,
    providerId: 'mock',
    language: 'sv',
    segments: [],
    chunks: [],
    speakerNames: {},
    ...partial,
  };
}

describe('speaker naming', () => {
  it('names session-scoped speakers A, B in order of appearance', () => {
    const s = session({
      segments: [
        { start: 0, end: 1, speaker: '1', text: 'Hej', chunkIndex: 0, speakerScope: 'session' },
        { start: 1, end: 2, speaker: '0', text: 'Hej själv', chunkIndex: 0, speakerScope: 'session' },
        { start: 2, end: 3, speaker: '1', text: 'Läget?', chunkIndex: 1, speakerScope: 'session' },
      ],
    });
    const names = defaultSpeakerNames(s.segments);
    expect(names.get('s:1')).toBe('Talare A');
    expect(names.get('s:0')).toBe('Talare B');
    expect(names.size).toBe(2);
  });

  it('keeps chunk-scoped speakers apart per chunk', () => {
    const a = { start: 0, end: 1, speaker: '0', text: 'x', chunkIndex: 0, speakerScope: 'chunk' as const };
    const b = { ...a, chunkIndex: 1 };
    expect(speakerKey(a)).not.toBe(speakerKey(b));
    const names = defaultSpeakerNames([a, b]);
    expect(names.get(speakerKey(b))).toBe('Talare A (del 2)');
  });
});

describe('paragraphs and markdown', () => {
  it('merges adjacent segments of the same speaker and applies custom names', () => {
    const s = session({
      speakerNames: { 's:0': 'Peter' },
      segments: [
        { start: 0, end: 2, speaker: '0', text: 'Vi börjar.', chunkIndex: 0, speakerScope: 'session' },
        { start: 2, end: 4, speaker: '0', text: 'Punkt ett.', chunkIndex: 0, speakerScope: 'session' },
        { start: 4, end: 6, speaker: '1', text: 'Okej.', chunkIndex: 0, speakerScope: 'session' },
        { start: 6, end: 7, speaker: '1', text: '   ', chunkIndex: 0, speakerScope: 'session' },
      ],
    });
    const p = paragraphs(s);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ speaker: 'Peter', text: 'Vi börjar. Punkt ett.', start: 0, end: 4 });
    expect(p[1].speaker).toBe('Talare B');
    const md = toMarkdown(s);
    expect(md).toContain('# Veckomöte');
    expect(md).toContain('**Peter** [00:00]: Vi börjar. Punkt ett.');
    expect(md).toContain('Deltagare: Peter');
  });

  it('builds a filesystem-safe file name', () => {
    expect(sessionFileName(session({ title: 'Kund: A/B?' }))).toBe('2026-10-31_0905 Kund- A-B-.md');
  });
});
