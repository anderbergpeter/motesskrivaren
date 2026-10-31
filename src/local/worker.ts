/// <reference lib="webworker" />
/**
 * In-browser transcription worker: KB-Whisper / Whisper via transformers.js for
 * text with word timestamps, WavLM x-vectors for speaker embeddings, and an
 * online clustering per session so "S1" means the same person all meeting.
 * Everything runs on the device; nothing leaves the browser except the model
 * downloads from Hugging Face (cached after the first time).
 */
import { AutoModel, AutoProcessor, env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { SPEAKER_MODEL_ID, asrModelId, type LocalConfig, type LocalSegment, type WorkerRequest, type WorkerResponse } from './protocol';

env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const WINDOW_SEC = 2.0;
const HOP_SEC = 1.0;
const SILENCE_RMS = 0.006;

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

interface SpeakerState {
  centroids: Float32Array[];
  counts: number[];
}

type XVectorModel = { (inputs: unknown): Promise<{ embeddings: { data: Float32Array; dims: number[] } }> };
type Processor = (audio: Float32Array) => Promise<unknown>;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let asrKey = '';
let speakerModel: XVectorModel | null = null;
let speakerProcessor: Processor | null = null;
let device: 'webgpu' | 'wasm' = 'wasm';
const sessions = new Map<string, SpeakerState>();
let loading: Promise<void> | null = null;

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* fall through */
  }
  return 'wasm';
}

function progressHandler(label: string) {
  const seen = new Map<string, number>();
  return (p: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) {
      seen.set(p.file, p.progress ?? 0);
      const vals = [...seen.values()];
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      post({ type: 'progress', text: `${label}: laddar ner ${Math.round(avg)} %`, fraction: avg / 100 });
    } else if (p.status === 'initiate' && p.file) {
      seen.set(p.file, 0);
    } else if (p.status === 'ready') {
      post({ type: 'progress', text: `${label}: klar` });
    }
  };
}

async function ensureLoaded(config: LocalConfig): Promise<void> {
  const wanted = asrModelId(config.size, config.language);
  if (asr && asrKey === wanted && speakerModel) return;
  if (loading) {
    await loading;
    if (asr && asrKey === wanted && speakerModel) return;
  }
  loading = (async () => {
    device = await pickDevice();
    post({ type: 'progress', text: `Startar lokal motor (${device === 'webgpu' ? 'GPU' : 'CPU'})…` });

    if (!asr || asrKey !== wanted) {
      if (asr) await asr.dispose();
      asr = null;
      const dtype =
        device === 'webgpu'
          ? ({ encoder_model: 'fp32', decoder_model_merged: 'q4' } as const)
          : ({ encoder_model: 'q8', decoder_model_merged: 'q4' } as const);
      try {
        asr = await pipeline('automatic-speech-recognition', wanted, {
          device,
          dtype,
          progress_callback: progressHandler(`Talmodell (${wanted.split('/')[1]})`),
        });
      } catch (e) {
        if (device === 'webgpu') {
          // WebGPU can fail on some drivers; retry on CPU.
          device = 'wasm';
          post({ type: 'progress', text: 'GPU misslyckades, byter till CPU…' });
          asr = await pipeline('automatic-speech-recognition', wanted, {
            device,
            dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } as const,
            progress_callback: progressHandler(`Talmodell (${wanted.split('/')[1]})`),
          });
        } else throw e;
      }
      asrKey = wanted;
    }

    if (!speakerModel) {
      const progress = progressHandler('Röstmodell');
      speakerProcessor = (await AutoProcessor.from_pretrained(SPEAKER_MODEL_ID, { progress_callback: progress })) as unknown as Processor;
      speakerModel = (await AutoModel.from_pretrained(SPEAKER_MODEL_ID, {
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        device,
        progress_callback: progress,
      })) as unknown as XVectorModel;
    }
    post({ type: 'ready', device, asrModel: wanted });
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

async function embed(audio: Float32Array): Promise<Float32Array> {
  const inputs = await speakerProcessor!(audio);
  const out = await speakerModel!(inputs);
  return Float32Array.from(out.embeddings.data);
}

function assignSpeaker(state: SpeakerState, emb: Float32Array, threshold: number): number {
  let best = -1;
  let bestSim = -1;
  state.centroids.forEach((c, i) => {
    const sim = cosine(c, emb);
    if (sim > bestSim) {
      bestSim = sim;
      best = i;
    }
  });
  if (best >= 0 && bestSim >= threshold) {
    const n = state.counts[best];
    const c = state.centroids[best];
    for (let i = 0; i < c.length; i++) c[i] = (c[i] * n + emb[i]) / (n + 1);
    state.counts[best] = n + 1;
    return best;
  }
  state.centroids.push(emb);
  state.counts.push(1);
  return state.centroids.length - 1;
}

interface Word {
  start: number;
  end: number;
  text: string;
}

async function transcribeWords(pcm: Float32Array, language: string): Promise<Word[]> {
  const opts = {
    language,
    task: 'transcribe' as const,
    chunk_length_s: 30,
    stride_length_s: 5,
    condition_on_prev_tokens: false,
  };
  type Chunked = { text: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> };
  let out: Chunked;
  try {
    out = (await asr!(pcm, { ...opts, return_timestamps: 'word' })) as Chunked;
  } catch {
    // Word-level alignment can fail; segment timestamps are good enough as fallback.
    out = (await asr!(pcm, { ...opts, return_timestamps: true })) as Chunked;
  }
  const words: Word[] = [];
  const total = pcm.length / SAMPLE_RATE;
  for (const c of out.chunks ?? []) {
    const text = c.text.trim();
    if (!text) continue;
    const start = c.timestamp[0] ?? 0;
    const end = c.timestamp[1] ?? Math.min(total, start + 1);
    words.push({ start, end, text });
  }
  if (words.length === 0 && out.text?.trim()) words.push({ start: 0, end: total, text: out.text.trim() });
  return words;
}

async function diarize(pcm: Float32Array, state: SpeakerState, threshold: number): Promise<Array<{ start: number; end: number; speaker: number }>> {
  const windows: Array<{ start: number; end: number; speaker: number }> = [];
  const win = Math.round(WINDOW_SEC * SAMPLE_RATE);
  const hop = Math.round(HOP_SEC * SAMPLE_RATE);
  for (let s = 0; s < pcm.length; s += hop) {
    const e = Math.min(pcm.length, s + win);
    if (e - s < SAMPLE_RATE * 0.8) break;
    const slice = pcm.subarray(s, e);
    if (rms(slice) < SILENCE_RMS) continue;
    const emb = await embed(slice);
    windows.push({ start: s / SAMPLE_RATE, end: e / SAMPLE_RATE, speaker: assignSpeaker(state, emb, threshold) });
  }
  return windows;
}

/** A single window that differs from identical neighbours is almost always noise; give it the neighbours' speaker. */
function smoothWindows(w: Array<{ start: number; end: number; speaker: number }>): Array<{ start: number; end: number; speaker: number }> {
  for (let i = 1; i < w.length - 1; i++) {
    if (w[i - 1].speaker === w[i + 1].speaker && w[i].speaker !== w[i - 1].speaker) w[i].speaker = w[i - 1].speaker;
  }
  return w;
}

function speakerAt(windows: Array<{ start: number; end: number; speaker: number }>, t: number, fallback: number): number {
  // Prefer the window whose centre is closest to t.
  let best = fallback;
  let bestDist = Infinity;
  for (const w of windows) {
    if (t < w.start - 0.5 || t > w.end + 0.5) continue;
    const d = Math.abs((w.start + w.end) / 2 - t);
    if (d < bestDist) {
      bestDist = d;
      best = w.speaker;
    }
  }
  return best;
}

async function handleTranscribe(id: number, sessionId: string, config: LocalConfig, pcm: Float32Array): Promise<void> {
  const t0 = performance.now();
  await ensureLoaded(config);
  const state = sessions.get(sessionId) ?? { centroids: [], counts: [] };
  sessions.set(sessionId, state);

  const tAsr = performance.now();
  const words = await transcribeWords(pcm, config.language);
  const tDia = performance.now();
  const windows = smoothWindows(await diarize(pcm, state, config.speakerThreshold));
  const tEnd = performance.now();
  console.info(`[lokal] whisper ${Math.round(tDia - tAsr)} ms, talare ${Math.round(tEnd - tDia)} ms, ${windows.length} fönster`);

  const segments: LocalSegment[] = [];
  let lastSpeaker = 0;
  for (const w of words) {
    // Whisper invents short phrases ("Ja.", "Tack.") on silence; drop words with no energy under them.
    const a = Math.max(0, Math.floor(w.start * SAMPLE_RATE));
    const b = Math.min(pcm.length, Math.ceil(Math.max(w.end, w.start + 0.3) * SAMPLE_RATE));
    if (b <= a || rms(pcm.subarray(a, b)) < SILENCE_RMS) continue;
    const spk = speakerAt(windows, (w.start + w.end) / 2, lastSpeaker);
    lastSpeaker = spk;
    const label = `S${spk + 1}`;
    const last = segments[segments.length - 1];
    if (last && last.speaker === label && w.start - last.end < 3) {
      last.text += (w.text.startsWith(',') || w.text.startsWith('.') ? '' : ' ') + w.text;
      last.end = w.end;
    } else {
      segments.push({ start: w.start, end: w.end, speaker: label, text: w.text });
    }
  }
  post({ type: 'result', id, segments, ms: Math.round(performance.now() - t0) });
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') await ensureLoaded(msg.config);
    else if (msg.type === 'transcribe') await handleTranscribe(msg.id, msg.sessionId, msg.config, msg.pcm);
    else if (msg.type === 'endSession') sessions.delete(msg.sessionId);
  } catch (e) {
    post({ type: 'error', id: msg.type === 'transcribe' ? msg.id : undefined, message: e instanceof Error ? e.message : String(e) });
  }
};
