"""
Mötesskrivaren – egen transkriberingsserver (referensimplementation).

KB-Whisper (svensk finjusterad Whisper) via faster-whisper + pyannote speaker
diarization, med talarspårning över minutdelar: varje del diariseras för sig,
talarnas röst-embeddings matchas mot sessionens kända talare, så att "S1" i
del 3 är samma person som "S1" i del 1. Embeddings hålls bara i minnet under
sessionen och kastas när sessionen stängs eller servern startas om.

OBS: Inte testad på GPU i det här repot ännu, se README.md i den här mappen.

Kör:  uvicorn app:app --host 0.0.0.0 --port 8000
Env:  HF_TOKEN (för pyannote), API_TOKEN (valfri bearer-token), WHISPER_MODEL
"""

from __future__ import annotations

import io
import os
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel
from pyannote.audio import Inference, Model, Pipeline

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "KBLab/kb-whisper-large")
API_TOKEN = os.environ.get("API_TOKEN")
HF_TOKEN = os.environ.get("HF_TOKEN")
SESSION_TTL_SECONDS = 6 * 3600
MATCH_THRESHOLD = float(os.environ.get("SPEAKER_MATCH_THRESHOLD", "0.65"))  # cosine similarity

app = FastAPI(title="Mötesskrivaren server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

whisper = WhisperModel(WHISPER_MODEL, device=DEVICE, compute_type="float16" if DEVICE == "cuda" else "int8")
diarizer = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=HF_TOKEN).to(torch.device(DEVICE))
embedder = Inference(Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", token=HF_TOKEN), window="whole").to(torch.device(DEVICE))


@dataclass
class SessionState:
    centroids: list[np.ndarray] = field(default_factory=list)  # one per known speaker
    counts: list[int] = field(default_factory=list)
    last_seen: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)


sessions: dict[str, SessionState] = {}
sessions_lock = threading.Lock()


def get_session(session_id: str) -> SessionState:
    with sessions_lock:
        now = time.time()
        for sid in [s for s, st in sessions.items() if now - st.last_seen > SESSION_TTL_SECONDS]:
            del sessions[sid]
        st = sessions.setdefault(session_id, SessionState())
        st.last_seen = now
        return st


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def assign_speaker(state: SessionState, emb: np.ndarray) -> int:
    """Match an embedding against known speakers; add a new one if nothing is close enough."""
    best, best_sim = -1, -1.0
    for i, c in enumerate(state.centroids):
        sim = cosine(c, emb)
        if sim > best_sim:
            best, best_sim = i, sim
    if best >= 0 and best_sim >= MATCH_THRESHOLD:
        n = state.counts[best]
        state.centroids[best] = (state.centroids[best] * n + emb) / (n + 1)
        state.counts[best] = n + 1
        return best
    state.centroids.append(emb)
    state.counts.append(1)
    return len(state.centroids) - 1


@app.post("/v1/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    chunk_index: int = Form(0),
    language: str = Form("sv"),
    authorization: str | None = Header(default=None),
):
    if API_TOKEN and authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(401, "Fel token")

    data = await file.read()
    audio, sr = sf.read(io.BytesIO(data), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        raise HTTPException(400, "Skicka 16 kHz mono WAV")
    duration = len(audio) / sr
    if duration < 0.5:
        return {"segments": []}

    # 1) Transcription with word timestamps (KB-Whisper).
    segments_iter, _ = whisper.transcribe(
        audio,
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    words = [w for seg in segments_iter for w in (seg.words or [])]

    # 2) Diarization of this chunk (labels local to the chunk).
    waveform = torch.from_numpy(audio).unsqueeze(0)
    diar = diarizer({"waveform": waveform, "sample_rate": sr})
    annotation = getattr(diar, "speaker_diarization", diar)

    # 3) Map local labels to session-wide speakers via embeddings.
    state = get_session(session_id)
    local_to_session: dict[str, int] = {}
    with state.lock:
        for label in annotation.labels():
            timeline = annotation.label_timeline(label)
            pieces = []
            for seg in timeline:
                a, b = int(seg.start * sr), int(seg.end * sr)
                if b - a >= int(0.4 * sr):
                    pieces.append(audio[a:b])
            if not pieces:
                continue
            speech = np.concatenate(pieces)[: sr * 20]
            emb = embedder({"waveform": torch.from_numpy(speech).unsqueeze(0), "sample_rate": sr})
            local_to_session[label] = assign_speaker(state, np.asarray(emb).reshape(-1))

    # 4) Give each word the speaker that overlaps its midpoint, then merge into turns.
    def speaker_at(t: float) -> str:
        for seg, _, label in annotation.itertracks(yield_label=True):
            if seg.start <= t <= seg.end:
                return f"S{local_to_session.get(label, 0) + 1}"
        return "S?"

    out: list[dict] = []
    for w in words:
        spk = speaker_at((w.start + w.end) / 2)
        if spk == "S?" and out:
            spk = out[-1]["speaker"]
        if out and out[-1]["speaker"] == spk:
            out[-1]["text"] += w.word
            out[-1]["end"] = w.end
        else:
            out.append({"start": w.start, "end": w.end, "speaker": spk, "text": w.word})
    for s in out:
        s["text"] = s["text"].strip()
    return {"segments": [s for s in out if s["text"]], "chunk_index": chunk_index, "duration": duration}


@app.delete("/v1/sessions/{session_id}")
def end_session(session_id: str):
    """Forget the session's speaker embeddings (call when the meeting ends)."""
    with sessions_lock:
        sessions.pop(session_id, None)
    return {"ok": True}


@app.get("/healthz")
def healthz():
    return {"ok": True, "device": DEVICE, "model": WHISPER_MODEL}
