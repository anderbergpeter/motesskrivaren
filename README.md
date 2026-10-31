# Mötesskrivaren

Lägg telefonen på bordet, tryck på **Starta transkribering**, och få ett svenskt transkript med talare A/B/C som sparas löpande i din egen Google Drive eller OneDrive. Statisk webbapp på GitHub Pages: **https://anderbergpeter.github.io/motesskrivaren/**

**Helt gratis som standard.** Transkriberingen körs i din egen webbläsare med KB-Whisper (Kungliga bibliotekets svenska Whisper) och en lokal röstmodell för talarindelning. Inga konton, inga API-nycklar, inget ljud lämnar enheten. Första gången laddas modellerna ner (ca 140 MB + 96 MB) och sparas i webbläsaren. Välj ett annat språk så byter appen till OpenAI:s flerspråkiga Whisper (99 språk). Betaltjänster med egen nyckel finns kvar som alternativ för den som vill ha högre kvalitet eller snabbare text.

Bakgrund, jämförelser och juridik finns i [docs/RESEARCH.md](docs/RESEARCH.md).

## Så funkar det

```
Mikrofon ─► AudioWorklet (kontinuerlig PCM) ─► 16 kHz WAV-delar var 60:e sekund
                 │                                      │
                 │ (realtidsleverantör)                 ├─► IndexedDB (lokal reserv)
                 ▼                                      ├─► Transkriberingstjänst ─► segment med talare
        WebSocket-ström                                 └─► (valfritt) ljuddel till molnet
                                                               │
                             Transkript (.md) skrivs om till Drive/OneDrive efter varje del
```

- **Inga glapp mellan delarna.** Ljudet fångas som en obruten PCM-ström och klipps i mjukvara. (MediaRecorder-bitar är inte självständigt spelbara, därför används de inte.)
- **Tappar du telefonen eller nätet** finns alla delar lokalt i IndexedDB och kan skickas om (röd ruta = klicka för nytt försök).
- **Konsekventa talare.** Realtidsleverantörer (Speechmatics, Soniox, Deepgram) håller en WebSocket öppen hela mötet, så "Talare A" är samma person från början till slut. Batchleverantörer (ElevenLabs, OpenAI) numrerar per minutdel; då kör du **helfilsanalys** efteråt så skickas hela mötet i ett anrop.
- **Döp talarna** genom att klicka på etiketten. Namnet skrivs in i transkriptet och sparas.
- **Transkriptet** är Markdown med tidsstämplar, klart att klistra in i en AI för mötesanteckningar och att-göra-punkter.

## Leverantörer

| Leverantör | Typ | Svenska | Talare | Ca kostnad / mötestimme | EU |
|---|---|---|---|---|---|
| **I webbläsaren (standard)** | lokal batch | KB-Whisper tiny/base/small (WER 13/9/7 %) | hela mötet via lokal röstmatchning (WavLM) | **0 kr** | all data på enheten |
| Webbläsarens taligenkänning | ström | ja (Google/Apple) | nej | 0 kr | leverantörens moln |
| Speechmatics realtid (rekommenderad) | ström | ja, publicerad svensk WER | hela mötet | 5–8 USD (0,45–0,80) | ja, eu.rt |
| Soniox realtid | ström | ja | hela mötet | 0,12 USD | på begäran |
| Deepgram Nova-2/3 live | ström | ja | hela mötet | 0,6–0,7 USD | api.eu (kräver kodändring) |
| ElevenLabs Scribe v2 | batch | ja, toppklass | per del, helfil efteråt | 0,22 USD | enterprise |
| OpenAI gpt-4o-transcribe-diarize | batch | ja | per del, ingen helfil (25 MB) | 0,27–0,36 USD | gated |
| Egen server (KB-Whisper + pyannote) | batch | bäst svenska (KB-Whisper) | hela mötet via röstmatchning | el + GPU | hos dig |
| Demo | – | – | – | gratis | – |

API-nyckeln sparas bara i webbläsarens localStorage. Den som har din upplåsta telefon kan läsa den; använd en nyckel med spärr på förbrukning.

## Kom igång

```bash
npm install
npm run dev        # http://localhost:5173
npm test
npm run build      # dist/ för GitHub Pages
```

Deploy: pusha till `main`, workflowen `.github/workflows/pages.yml` bygger och publicerar. Aktivera Pages med källan "GitHub Actions" i repots inställningar.

### Google Drive

1. Google Cloud Console → skapa projekt → **APIs & Services → Credentials → OAuth client ID → Web application**.
2. Authorized JavaScript origins: din Pages-adress (t.ex. `https://<användare>.github.io`) och `http://localhost:5173` för utveckling.
3. Aktivera **Google Drive API**. Konsentskärmen behöver bara scopet `drive.file` (ej känsligt, ingen granskning). Lägg till dig själv som testanvändare om appen står i "Testing".
4. Klistra in klient-id:t i appens inställningar och logga in. Filerna hamnar i mappen **Mötesskrivaren** i din Drive, och appen ser bara filer den själv skapat.

Google-tokens gäller i en timme. Appen ber om ny inloggning när det behövs, men molnsynken kan stå still en stund under långa möten; allt finns lokalt och synkas vid stopp.

### OneDrive (Microsoft 365 / Entra)

1. Entra admin center → **App registrations → New registration**, konto­typ "Accounts in any organizational directory and personal Microsoft accounts".
2. Platform **Single-page application**, redirect URI = din Pages-adress (och `http://localhost:5173`).
3. API permissions: **Files.ReadWrite.AppFolder**, **User.Read** (delegerade, ingen admin-consent krävs normalt).
4. Klistra in Application (client) ID i appen. Filerna hamnar i **OneDrive/Appar/Mötesskrivaren**.

### Egen server

Se [server/README.md](server/README.md).

## På mobilen

- Håll skärmen tänd och appen i förgrunden. iOS stänger mikrofonen när skärmen låses, särskilt för "hemskärms-appar"; kör i Safari-fliken, inte som installerad app. Appen begär Wake Lock så skärmen inte slocknar; sänk ljusstyrkan och ladda telefonen.
- Ett inkommande samtal tystar mikrofonen tills sidan laddas om.
- 1,9 MB ljud per minut lokalt (230 MB för två timmar) ryms gott i IndexedDB.

## Juridik i korthet

- Du får spela in möten du själv deltar i (BrB 4 kap. 9 a §), men informera deltagarna och sluta om någon invänder (GDPR art. 13/21).
- Talarindelning inom ett möte är inte biometrisk identifiering. Att spara röstprofiler mellan möten vore det (art. 9), därför gör appen inte det.
- **Känsloanalys av röster på arbetsplatsen är förbjuden** enligt AI-förordningen art. 5.1 f sedan 2 februari 2025 (upp till 35 MEUR i sanktion). Funktionen är medvetet utelämnad.
- Spara i jobbkontot, radera ljudet efter granskning, bestäm hur länge transkriptet behålls.

Detaljer och källor: [docs/RESEARCH.md](docs/RESEARCH.md).

## Lokal motor: vad man kan förvänta sig

- Testat på en Windows-dator med WebGPU: en 30-sekundersdel tar 7–10 sekunder efter uppvärmning (de två första delarna 20–30 s medan GPU-shaders kompileras). På en telefon utan WebGPU går det långsammare; texten släpar efter men hinner ikapp i pauser, och inget ljud tappas eftersom allt sparas lokalt först.
- Talarindelningen räknar en röstsignatur per 2-sekundersfönster och matchar mot mötets kända talare (cosinuslikhet ≥ 0,75). I testet med två uppläsare som växlade var 15:e sekund blev varje byte rätt över fyra delar. Signaturerna lever bara i minnet under mötet.
- Tystnad filtreras bort så att Whisper inte hittar på korta fraser.
- Modellstorlek väljs i inställningarna: tiny för gamla telefoner, base som standard, small på dator med GPU.

## Status

- Verifierat: inspelning → chunkning → lokal lagring → lokal transkribering med KB-Whisper → talarindelning → transkriptvy → export, med svenskt testljud från två uppläsare.
- Skrivet enligt officiell dokumentation men **inte kört med riktiga nycklar ännu**: Speechmatics, Soniox, Deepgram, ElevenLabs, OpenAI, Google Drive, OneDrive, egen server. Räkna med småjusteringar vid första körning.
