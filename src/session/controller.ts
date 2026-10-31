import type { PcmChunk } from '../audio/chunker';
import { Recorder } from '../audio/recorder';
import { encodeWav, floatToInt16 } from '../audio/wav';
import type { CloudStorage } from '../cloud/types';
import { getProvider, type BatchProvider, type ProviderSettings, type RawSegment, type StreamProvider } from '../providers';
import { db, requestPersistentStorage } from '../storage/db';
import type { Settings } from '../settings';
import { sessionFileName, toMarkdown, type Segment, type Session } from '../transcript/model';

export type ControllerEvent =
  | { type: 'session'; session: Session }
  | { type: 'level'; level: number }
  | { type: 'status'; text: string; kind?: 'info' | 'warn' | 'error' }
  | { type: 'cloud'; text: string; ok: boolean };

type Listener = (e: ControllerEvent) => void;

const MAX_RETRIES = 4;

/**
 * Owns one meeting: recording, chunking, transcription queue, local persistence
 * and cloud sync. The UI only listens to events and calls start/stop/rename.
 */
export class MeetingController {
  private listeners = new Set<Listener>();
  private recorder: Recorder | null = null;
  private session: Session | null = null;
  private stream: Awaited<ReturnType<StreamProvider['connect']>> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private cloudTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudBusy = false;
  private cloudDirty = false;
  private stopping = false;

  constructor(
    private settings: Settings,
    private cloud: CloudStorage | null,
  ) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: ControllerEvent): void {
    for (const l of this.listeners) l(e);
  }

  get current(): Session | null {
    return this.session;
  }

  get isRecording(): boolean {
    return this.recorder?.running ?? false;
  }

  get elapsedSeconds(): number {
    return this.recorder?.elapsedSeconds ?? 0;
  }

  get pendingChunks(): number {
    return this.inFlight;
  }

  updateSettings(settings: Settings, cloud: CloudStorage | null): void {
    this.settings = settings;
    this.cloud = cloud;
  }

  /** Re-open an old session for viewing / renaming / export. */
  load(session: Session): void {
    if (this.isRecording) throw new Error('Stoppa inspelningen först');
    this.session = session;
    this.emit({ type: 'session', session });
  }

  private providerSettings(): ProviderSettings {
    const p = getProvider(this.settings.providerId);
    return {
      apiKey: this.settings.apiKeys[p.id] ?? '',
      baseUrl: this.settings.selfHostedUrl,
      model: this.settings.model,
      language: this.settings.language,
    };
  }

  async start(title: string): Promise<void> {
    if (this.isRecording) return;
    const provider = getProvider(this.settings.providerId);
    const ps = this.providerSettings();
    if (provider.id !== 'mock' && provider.id !== 'selfhosted' && !ps.apiKey) {
      throw new Error(`Ange API-nyckel för ${provider.label} i inställningarna`);
    }
    await requestPersistentStorage();

    const session: Session = {
      id: crypto.randomUUID(),
      title: title.trim() || `Möte ${new Date().toLocaleDateString('sv-SE')}`,
      startedAt: new Date().toISOString(),
      chunkSeconds: this.settings.chunkSeconds,
      providerId: provider.id,
      language: this.settings.language,
      segments: [],
      chunks: [],
      speakerNames: {},
    };
    this.session = session;
    this.stopping = false;
    await db.saveSession(session);
    this.emit({ type: 'session', session });

    if (provider.kind === 'stream') {
      this.emit({ type: 'status', text: `Ansluter till ${provider.label}…` });
      this.stream = await provider.connect(ps, {
        onSegments: (segs) => this.addSegments(segs, -1, 'session', 0),
        onError: (err) => this.emit({ type: 'status', text: err.message, kind: 'error' }),
      });
    }

    this.recorder = new Recorder({
      onChunk: (chunk) => this.handleChunk(chunk, provider),
      onLevel: (level) => this.emit({ type: 'level', level }),
      onPcm: provider.kind === 'stream' ? (pcm) => this.stream?.sendPcm(floatToInt16(pcm)) : undefined,
      onError: (err) => this.emit({ type: 'status', text: err.message, kind: 'error' }),
    });
    try {
      await this.recorder.start(this.settings.chunkSeconds);
    } catch (e) {
      await this.stream?.close().catch(() => undefined);
      this.stream = null;
      this.recorder = null;
      throw e instanceof Error ? e : new Error(String(e));
    }
    this.emit({ type: 'status', text: 'Spelar in' });
    void this.ensureCloudFile();
  }

  async stop(): Promise<void> {
    if (!this.recorder || !this.session) return;
    this.stopping = true;
    this.emit({ type: 'status', text: 'Avslutar…' });
    await this.recorder.stop();
    this.recorder = null;
    if (this.stream) {
      await this.stream.close().catch(() => undefined);
      this.stream = null;
    }
    await this.queue; // wait for the last chunk transcriptions
    this.session.endedAt = new Date().toISOString();
    await this.persist();
    await this.syncCloud(true);
    this.emit({ type: 'status', text: 'Klart. Transkriptet är sparat.' });
  }

  renameSpeaker(key: string, name: string): void {
    if (!this.session) return;
    if (name.trim()) this.session.speakerNames[key] = name.trim();
    else delete this.session.speakerNames[key];
    void this.persist();
    this.scheduleCloud();
  }

  renameSession(title: string): void {
    if (!this.session) return;
    this.session.title = title.trim() || this.session.title;
    void this.persist();
    this.scheduleCloud();
  }

  /** Re-send a chunk that failed earlier. */
  async retryChunk(index: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    const meta = s.chunks.find((c) => c.index === index);
    const blob = await db.getChunk(s.id, index);
    if (!meta || !blob) throw new Error('Ljuddelen finns inte kvar lokalt');
    const provider = getProvider(s.providerId);
    if (provider.kind !== 'batch') throw new Error('Går bara för batch-leverantörer');
    await this.transcribeChunk(blob, meta.index, meta.startSec, meta.durationSec, provider);
  }

  /**
   * Full-file pass: concatenate all local chunks and transcribe them in one call,
   * giving consistent speakers for batch providers whose labels are chunk-local.
   */
  async fullFilePass(): Promise<void> {
    const s = this.session;
    if (!s) throw new Error('Inget möte laddat');
    if (this.isRecording) throw new Error('Stoppa inspelningen först');
    const provider = getProvider(s.providerId);
    if (provider.kind !== 'batch') throw new Error('Leverantören ger redan konsekventa talare');
    const total = s.chunks.reduce((a, c) => a + c.durationSec, 0);
    if ((provider.maxFullFileSeconds ?? 0) < total) throw new Error('Leverantören tar inte emot hela filen i ett anrop');
    const blobs = await db.listChunks(s.id);
    if (blobs.length !== s.chunks.length) throw new Error('Alla ljuddelar finns inte kvar lokalt');
    this.emit({ type: 'status', text: 'Analyserar hela mötet för konsekventa talare…' });
    const pcm = await concatWav(blobs);
    const segs = await provider.transcribe(pcm, { sessionId: s.id, chunkIndex: -1, startSec: 0, durationSec: total }, this.providerSettings());
    s.segments = [];
    s.speakerNames = {};
    this.addSegments(segs, -1, 'session', 0);
    s.finalPassDone = true;
    await this.persist();
    await this.syncCloud(true);
    this.emit({ type: 'status', text: 'Helfilsanalys klar' });
  }

  /** Delete locally stored audio for the current session (the transcript stays). */
  async deleteLocalAudio(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await db.deleteChunks(s.id);
    this.emit({ type: 'status', text: 'Ljudet raderades från den här enheten' });
  }

  private handleChunk(chunk: PcmChunk, provider: ReturnType<typeof getProvider>): void {
    const s = this.session;
    if (!s) return;
    const wav = encodeWav(floatToInt16(chunk.samples), 16000);
    s.chunks.push({ index: chunk.index, startSec: chunk.startSec, durationSec: chunk.durationSec, status: 'pending' });
    this.emit({ type: 'session', session: s });
    this.queue = this.queue
      .then(async () => {
        await db.saveChunk(s.id, chunk.index, wav);
        await this.persist();
        if (this.settings.uploadAudio) void this.uploadAudio(chunk.index, wav);
        if (provider.kind === 'batch') await this.transcribeChunk(wav, chunk.index, chunk.startSec, chunk.durationSec, provider);
      })
      .catch((e) => this.emit({ type: 'status', text: String(e), kind: 'error' }));
  }

  private async transcribeChunk(wav: Blob, index: number, startSec: number, durationSec: number, provider: BatchProvider): Promise<void> {
    const s = this.session;
    if (!s) return;
    const meta = s.chunks.find((c) => c.index === index)!;
    meta.status = 'sent';
    meta.error = undefined;
    this.inFlight++;
    this.emit({ type: 'session', session: s });
    try {
      let attempt = 0;
      for (;;) {
        try {
          const segs = await provider.transcribe(wav, { sessionId: s.id, chunkIndex: index, startSec, durationSec }, this.providerSettings());
          // Replace any earlier result for this chunk (retry case).
          s.segments = s.segments.filter((x) => x.chunkIndex !== index);
          this.addSegments(segs, index, provider.speakerScope, startSec);
          meta.status = 'done';
          break;
        } catch (e) {
          attempt++;
          const retryable = !(e instanceof Object && 'retryable' in e && (e as { retryable: boolean }).retryable === false);
          if (!retryable || attempt > MAX_RETRIES) {
            meta.status = 'failed';
            meta.error = e instanceof Error ? e.message : String(e);
            this.emit({ type: 'status', text: `Del ${index + 1} misslyckades: ${meta.error}`, kind: 'warn' });
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
        }
      }
    } finally {
      this.inFlight--;
      await this.persist();
      this.emit({ type: 'session', session: s });
      this.scheduleCloud();
    }
  }

  private addSegments(raw: RawSegment[], chunkIndex: number, scope: Segment['speakerScope'], offset: number): void {
    const s = this.session;
    if (!s) return;
    for (const r of raw) {
      if (!r.text.trim()) continue;
      s.segments.push({
        start: r.start + offset,
        end: r.end + offset,
        speaker: r.speaker,
        text: r.text,
        chunkIndex,
        speakerScope: scope,
      });
    }
    s.segments.sort((a, b) => a.start - b.start);
    void this.persist();
    this.emit({ type: 'session', session: s });
    if (chunkIndex === -1 && scope === 'session') this.scheduleCloud();
  }

  private async persist(): Promise<void> {
    if (this.session) await db.saveSession(this.session).catch((e) => this.emit({ type: 'status', text: `Kunde inte spara lokalt: ${e}`, kind: 'error' }));
  }

  // ---- Cloud sync -------------------------------------------------------

  private scheduleCloud(): void {
    if (!this.cloud) return;
    this.cloudDirty = true;
    if (this.cloudTimer) return;
    this.cloudTimer = setTimeout(() => {
      this.cloudTimer = null;
      void this.syncCloud(false);
    }, 3000);
  }

  private async ensureCloudFile(): Promise<void> {
    const s = this.session;
    if (!s || !this.cloud) return;
    if (!this.cloud.isConnected()) {
      this.emit({ type: 'cloud', text: `${this.cloud.label}: inte inloggad, sparar bara lokalt`, ok: false });
      return;
    }
    try {
      const root = await this.cloud.ensureRootFolder();
      s.cloud = { kind: this.cloud.kind, folderId: root };
      await this.persist();
      await this.syncCloud(true);
    } catch (e) {
      this.emit({ type: 'cloud', text: `${this.cloud.label}: ${e instanceof Error ? e.message : e}`, ok: false });
    }
  }

  private async syncCloud(force: boolean): Promise<void> {
    const s = this.session;
    if (!s || !this.cloud || !this.cloud.isConnected()) return;
    if (this.cloudBusy) {
      this.cloudDirty = true;
      return;
    }
    if (!force && !this.cloudDirty) return;
    this.cloudBusy = true;
    this.cloudDirty = false;
    try {
      if (!s.cloud?.folderId) s.cloud = { kind: this.cloud.kind, folderId: await this.cloud.ensureRootFolder() };
      const id = await this.cloud.putText(s.cloud.folderId!, sessionFileName(s), toMarkdown(s), s.cloud.transcriptFileId);
      s.cloud.transcriptFileId = id;
      await this.persist();
      this.emit({ type: 'cloud', text: `${this.cloud.label}: synkat ${new Date().toLocaleTimeString('sv-SE')}`, ok: true });
    } catch (e) {
      this.cloudDirty = true;
      this.emit({ type: 'cloud', text: `${this.cloud.label}: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      this.cloudBusy = false;
      if (this.cloudDirty && !this.stopping) this.scheduleCloud();
    }
  }

  private async uploadAudio(index: number, wav: Blob): Promise<void> {
    const s = this.session;
    if (!s || !this.cloud || !this.cloud.isConnected() || !s.cloud?.folderId) return;
    try {
      if (!s.cloud.audioFolderId) {
        s.cloud.audioFolderId = await this.cloud.ensureFolder(s.cloud.folderId, `${sessionFileName(s).replace(/\.md$/, '')} – ljud`);
      }
      await this.cloud.putBlob(s.cloud.audioFolderId, `del-${String(index + 1).padStart(4, '0')}.wav`, wav);
      const meta = s.chunks.find((c) => c.index === index);
      if (meta) meta.uploaded = true;
      await this.persist();
    } catch (e) {
      this.emit({ type: 'cloud', text: `Ljuduppladdning del ${index + 1}: ${e instanceof Error ? e.message : e}`, ok: false });
    }
  }
}

/** Concatenate WAV blobs with identical format into one WAV. */
export async function concatWav(blobs: Blob[]): Promise<Blob> {
  const parts: Int16Array[] = [];
  let total = 0;
  for (const b of blobs) {
    if (b.size <= 44) continue;
    const buf = await b.arrayBuffer();
    const pcm = new Int16Array(buf, 44, (buf.byteLength - 44) >> 1);
    parts.push(pcm);
    total += pcm.length;
  }
  const all = new Int16Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return encodeWav(all, 16000);
}
