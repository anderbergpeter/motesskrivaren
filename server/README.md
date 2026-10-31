# Egen server: KB-Whisper + pyannote

Referensimplementation av leverantören "Egen server" i appen. All ljuddata stannar hos dig.

**Status:** skriven men inte körd mot GPU i det här repot. Räkna med att behöva justera versioner.

## Krav

- Linux med NVIDIA-GPU (minst 8 GB VRAM för `kb-whisper-large` i float16). CPU fungerar men tar 30–60 minuter per mötestimme.
- Python 3.11+, ffmpeg.
- Hugging Face-konto. Acceptera villkoren för `pyannote/speaker-diarization-community-1` och `pyannote/wespeaker-voxceleb-resnet34-LM`, skapa en token.

## Kör

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export HF_TOKEN=hf_...
export API_TOKEN=valfri-hemlighet      # samma skrivs in i appen
uvicorn app:app --host 0.0.0.0 --port 8000
```

Exponera med HTTPS (t.ex. Caddy eller Cloudflare Tunnel), skriv in adressen i appens inställningar.

## Hur talarna hålls ihop mellan minutdelar

1. Varje minutdel diariseras för sig med pyannote (etiketter lokala för delen).
2. För varje lokal talare räknas en röst-embedding (WeSpeaker) på upp till 20 s tal.
3. Embeddingen matchas mot sessionens kända talare (cosinuslikhet, tröskel `SPEAKER_MATCH_THRESHOLD`, standard 0,65). Träff = samma talare, annars ny talare.
4. Embeddings lever bara i serverns minne under sessionen (max 6 h) och raderas med `DELETE /v1/sessions/{id}`. Inget sparas mellan möten, för det vore biometrisk identifiering enligt GDPR art. 9.

Tröskeln behöver trimmas mot riktiga möten: för lågt slår ihop talare, för högt skapar nya.

## Alternativ med bättre kvalitet

Kör i stället hela mötets ljud i ett svep efteråt med [WhisperX](https://github.com/m-bain/whisperX) och KB-Whisper (CT2-bygget), så sköter pyannote klustringen globalt över hela filen. Appen kan ladda upp alla minutdelar till molnet för det ändamålet (inställningen "Ladda även upp ljudet").
