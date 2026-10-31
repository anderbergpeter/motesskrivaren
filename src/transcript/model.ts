export interface Segment {
  /** Seconds from session start. */
  start: number;
  end: number;
  /** Raw speaker label from the provider, e.g. "0", "speaker_1". */
  speaker: string;
  text: string;
  /** Which chunk produced it; -1 for a full-file pass. */
  chunkIndex: number;
  /**
   * 'session' when the label is consistent for the whole meeting,
   * 'chunk' when it is only consistent within one chunk.
   */
  speakerScope: 'session' | 'chunk';
}

export type ChunkStatus = 'pending' | 'sent' | 'done' | 'failed';

export interface ChunkMeta {
  index: number;
  startSec: number;
  durationSec: number;
  status: ChunkStatus;
  error?: string;
  /** True once the raw audio was saved to the cloud. */
  uploaded?: boolean;
}

export interface Session {
  id: string;
  title: string;
  startedAt: string; // ISO
  endedAt?: string;
  chunkSeconds: number;
  providerId: string;
  language: string;
  segments: Segment[];
  chunks: ChunkMeta[];
  /** Map from speaker key (see speakerKey) to a human name. */
  speakerNames: Record<string, string>;
  /** Cloud file ids so we can update instead of re-create. */
  cloud?: { kind: 'google' | 'microsoft'; folderId?: string; transcriptFileId?: string; audioFolderId?: string };
  /** Set when a full-file pass replaced the chunk-local segments. */
  finalPassDone?: boolean;
}

/** Stable key for a speaker label, unique per chunk when the scope is chunk-local. */
export function speakerKey(seg: Pick<Segment, 'speaker' | 'speakerScope' | 'chunkIndex'>): string {
  return seg.speakerScope === 'session' ? `s:${seg.speaker}` : `c${seg.chunkIndex}:${seg.speaker}`;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Human-readable default name: "Talare A", "Talare B", in order of first appearance. */
export function defaultSpeakerNames(segments: Segment[]): Map<string, string> {
  const names = new Map<string, string>();
  const perChunkCounter = new Map<number, number>();
  let sessionCounter = 0;
  for (const seg of segments) {
    const key = speakerKey(seg);
    if (names.has(key)) continue;
    if (seg.speakerScope === 'session') {
      names.set(key, `Talare ${LETTERS[sessionCounter % 26] ?? sessionCounter}`);
      sessionCounter++;
    } else {
      const n = perChunkCounter.get(seg.chunkIndex) ?? 0;
      perChunkCounter.set(seg.chunkIndex, n + 1);
      names.set(key, `Talare ${LETTERS[n % 26]} (del ${seg.chunkIndex + 1})`);
    }
  }
  return names;
}

export function displayName(session: Session, seg: Segment, defaults: Map<string, string>): string {
  const key = speakerKey(seg);
  return session.speakerNames[key] ?? defaults.get(key) ?? seg.speaker;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Merge consecutive segments by the same speaker into paragraphs. */
export function paragraphs(session: Session): Array<{ speaker: string; start: number; end: number; text: string }> {
  const defaults = defaultSpeakerNames(session.segments);
  const sorted = [...session.segments].sort((a, b) => a.start - b.start);
  const out: Array<{ speaker: string; start: number; end: number; text: string }> = [];
  for (const seg of sorted) {
    const name = displayName(session, seg, defaults);
    const last = out[out.length - 1];
    const text = seg.text.trim();
    if (!text) continue;
    if (last && last.speaker === name && seg.start - last.end < 5) {
      last.text += ' ' + text;
      last.end = seg.end;
    } else {
      out.push({ speaker: name, start: seg.start, end: seg.end, text });
    }
  }
  return out;
}

/** Markdown transcript, the file that is stored in Drive/OneDrive and fed to an AI afterwards. */
export function toMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- Start: ${new Date(session.startedAt).toLocaleString('sv-SE')}`);
  if (session.endedAt) lines.push(`- Slut: ${new Date(session.endedAt).toLocaleString('sv-SE')}`);
  lines.push(`- Språk: ${session.language}`);
  lines.push(`- Transkribering: ${session.providerId}${session.finalPassDone ? ' (helfilsanalys klar)' : ''}`);
  const failed = session.chunks.filter((c) => c.status === 'failed').length;
  if (failed > 0) lines.push(`- OBS: ${failed} ljuddel(ar) kunde inte transkriberas`);
  lines.push('');
  const names = Object.values(session.speakerNames).filter(Boolean);
  if (names.length) {
    lines.push(`Deltagare: ${[...new Set(names)].join(', ')}`);
    lines.push('');
  }
  lines.push('## Transkript');
  lines.push('');
  for (const p of paragraphs(session)) {
    lines.push(`**${p.speaker}** [${formatTime(p.start)}]: ${p.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function sessionFileName(session: Session): string {
  const d = new Date(session.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safe = session.title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'mote';
  return `${stamp} ${safe}.md`;
}
