# Research: svensk mötestranskribering med talarindelning (2026-10-31)

Underlag för Mötesskrivaren. Fyra spår: open source, betaltjänster, juridik, webbläsarteknik. Källor länkas löpande; alla "stöder svenska"-påståenden kommer från officiell dokumentation.

## 1. Sammanfattning och rekommendation

**Fråga: är Whisper bäst?** För svenska: ja, men inte OpenAI:s Whisper utan **KB-Whisper** från Kungliga bibliotekets KBLab, en svenskfinjusterad Whisper large-v3. Den halverar felfrekvensen (WER) jämfört med OpenAI:s large-v3 på svenska testset och är Apache 2.0. Men Whisper gör ingen talarindelning; det kräver ett separat diariseringssteg (pyannote) och i praktiken en GPU-server. Ingen webbläsare på en telefon klarar två timmar med stor modell plus diarisering.

**Krav som tillkom efter första versionen: noll kronor och fungera direkt.** Då faller alla API-tjänster bort (nyckel krävs även för gratiskrediter) och den enda vägen är att köra modellerna i webbläsaren. Det visade sig fungera bättre än väntat: KBLab publicerar KB-Whisper i ONNX-format för transformers.js, och Xenova/wavlm-base-plus-sv ger talarsignaturer. Med WebGPU bearbetas 30 s ljud på 7–10 s; talarbyten i ett tvåpersonerstest träffades exakt över fyra minutdelar. Begränsningen är hårdvaran: på en äldre telefon utan WebGPU släpar texten efter. Detta är nu standardläget i appen; API-tjänsterna nedan finns kvar som tillval.

**Rekommenderad arkitektur** (det som är byggt):

1. Statisk webbapp på GitHub Pages. Ljudet fångas som obruten PCM via AudioWorklet och klipps i 60-sekundersdelar som 16 kHz WAV. Varje del sparas lokalt i IndexedDB innan något annat händer.
2. Transkribering med egen API-nyckel direkt från webbläsaren. **Förstaval: Speechmatics realtid** (svenska, EU-servrar, talaretiketter som gäller hela mötet, publicerad svensk WER). Budgetval: Soniox. Toppkvalitet i efterhand: ElevenLabs Scribe v2 på hela filen.
3. Transkriptet skrivs om som Markdown till **Google Drive** (mapp "Mötesskrivaren", scope `drive.file`) eller **OneDrive** (app-mappen) efter varje del. Drive kan inte "appenda", men filen är liten så hela skrivs om.
4. Valfri egen server med KB-Whisper + pyannote för den som vill hålla all data hos sig.

**Känsloanalys: byggs inte.** EU:s AI-förordning artikel 5.1 f förbjuder sedan 2 februari 2025 AI som drar slutsatser om känslor hos personer på arbetsplatsen. Kommissionens riktlinjer säger uttryckligen att "arg/glad från rösten" är känsloigenkänning och att det gäller alla som använder systemet i yrkesroll, även en enskild anställd i ett möte med kollegor. Se avsnitt 4.

## 2. Open source

| Komponent | Vad | Läge 2026 | Källa |
|---|---|---|---|
| **KB-Whisper** (KBLab) | Svensk Whisper, tiny→large | Large: WER 5,4/4,1/5,2 % (FLEURS/CommonVoice/NST) mot OpenAI large-v3 7,8/9,5/11,3 %. KB-small slår OpenAI large-v3. Apache 2.0, finns som CTranslate2/faster-whisper, GGML, ONNX. Senast uppdaterad aug 2025. | [modellkort](https://huggingface.co/KBLab/kb-whisper-large), [arXiv 2505.17538](https://arxiv.org/abs/2505.17538v2) |
| **WhisperX** | faster-whisper + ordjustering + pyannote | Aktivt (v3.8.6 maj 2026), BSD-2, svensk ordjustering via KBLab/voxrex, fungerar med KB-Whisper. GPU rekommenderas (<8 GB VRAM). | [releases](https://github.com/m-bain/whisperX/releases) |
| **pyannote.audio 4.0** | Talardiarisering | `speaker-diarization-community-1` (CC-BY, kräver HF-godkännande). DER ~20 % på AMI; betalmodellen precision-2 ~15 %. Språkoberoende. GPU: ~30 s per ljudtimme; CPU: 30–50 min per ljudtimme. Konsekventa etiketter **bara om hela filen körs i ett svep**; separata delar kräver egen embeddingmatchning. | [PyPI](https://pypi.org/project/pyannote-audio/), [community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) |
| **NVIDIA Nemotron-3-Diarization** (sep 2026) | Diarisering, 8 talare, streaming | Bättre DER än community-1, OpenMDW-licens, men NeMo 3/Linux/NVIDIA-GPU och otestad på svenska. | [modellkort](https://huggingface.co/nvidia/Nemotron-3-Diarization) |
| NVIDIA Canary-1b-v2 / Parakeet-tdt-0.6b-v3 | ASR 25 EU-språk inkl. svenska | Inga svenska siffror publicerade; inget tyder på att de slår KB-Whisper. | [canary](https://huggingface.co/nvidia/canary-1b-v2) |
| Voxtral (Mistral), Kyutai STT, SenseVoice, Moonshine | ASR | **Ingen svenska** (Voxtral 3 hävdar 24 EU-språk men svenska är inte bekräftat i docs). | [Mistral docs](https://docs.mistral.ai/capabilities/audio/speech_to_text) |
| emotion2vec+, audeering w2v2 | Känsloigenkänning ur röst | Tränade på kinesiska/engelska. Ingen svensk utvärdering alls. Bara grov "energi/arousal" är överförbar. Dessutom förbjudet på arbetsplats (avsnitt 4). | [emotion2vec](https://github.com/ddlBoJack/emotion2vec), [arXiv 2203.07378](https://arxiv.org/pdf/2203.07378v3) |
| I webbläsaren (transformers.js, whisper.cpp WASM, sherpa-onnx) | Allt lokalt på telefonen | KB tiny/base/small (WER 13/9/7 %) i ONNX. Uppmätt i appen: 30 s ljud på 7–10 s med WebGPU på dator, inklusive talarsignaturer via WavLM-sv. Utan WebGPU (äldre telefoner) flera gånger långsammare. **Fungerar, med reservation för hårdvaran**, och är gratis. | [whisper-web](https://github.com/xenova/whisper-web), [sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html) |

Färdiga självhostade paket: **Scriberr** (WhisperX-baserad, webbgränssnitt), WhisperLive/WhisperLiveKit (streaming, men diariseringen är engelskcentrerad och maxar 4 talare), Speaches (ingen diarisering), noScribe/Vibe (desktopprogram).

**Open source-ranking för svenska möten:** 1) KB-Whisper-large (CT2) + WhisperX 3.8 med pyannote community-1 på hela filen; 2) KB-Whisper + Nemotron-3-Diarization; 3) Canary/Parakeet + Nemotron-3. Alla kräver GPU för rimlig väntetid. Kostnad: en hyrd GPU (t.ex. RTX 4090-klass) för ~0,3–0,5 USD/h gör ett tvåtimmarsmöte på några minuter.

## 3. Betaltjänster

Krav: svenska, talarindelning, helst realtid med etiketter som håller hela mötet, nåbar direkt från webbläsaren, EU-hosting.

| Tjänst | Svenska batch / ström | Talare batch / ström | 2 h-fil | USD per ljudtimme batch / ström | Från webbläsare | EU |
|---|---|---|---|---|---|---|
| **Speechmatics** | ja / ja | ja / **ja, S1 S2 … hela sessionen** | ja | 0,45–0,75 / 0,45–0,80 (diarisering ingår) | JWT-nyckel | **ja**, eu.rt |
| **Soniox** | ja / ja | ja / ja | ja (5 h) | 0,10 / 0,12 | tillfällig nyckel | på begäran |
| **Deepgram** Nova-2/3 | ja / ja | ja / ja (v1) | ja (2 GB) | 0,26–0,31 / 0,46–0,55 + 0,12 | token-subprotokoll | api.eu |
| **AssemblyAI** | ja / ja (3.6 Pro) | ja / beta, kan revidera etiketter | ja (10 h) | 0,21 + 0,02 / 0,45 + 0,12 | tillfällig token | ja, samma pris |
| **ElevenLabs Scribe v2** | ja ("≤5 % WER"-klassen) / ja | **ja (32+ talare)** / **nej** | ja (10 h, 3 GB) | 0,22 / 0,39 | token (RT) | bara Enterprise |
| Gladia | ja (Solaria-1) / ja | ja / nej | ja | €0,27 / €0,68 | token-URL | ja (Frankrike) |
| Azure AI Speech | ja / ja | ja / ja (ConversationTranscriber) | ja (<5 h) | oklart (~0,36 / ~1,0) | SDK + token | swedencentral |
| Google STT Chirp 3 | ja / ja | **ingen diarisering för svenska** | nej (1 h) | 0,96 | proxy krävs | eu |
| OpenAI gpt-4o-transcribe-diarize | ja / – | ja (4 kända talare) / nej | **nej (25 MB)** | 0,27–0,36 | ja | gated |
| Amazon Transcribe | ja / ja | ja / ja | ja (8 h) | 0,36 / 0,60 | SigV4 (krångligt) | ja (ej Stockholm för ström) |
| Mistral Voxtral | nej (V2) | ja | ja | 0,18 / 0,36 | – | EU-bolag |
| Hume AI (känslor) | – | – | – | – | – | **API nedlagt juni 2026** |

Enda publicerade svenska jämförelsen är Speechmatics egen (FLEURS): Speechmatics 8,2 %, Amazon 8,2 %, Whisper large-v3 8,6 %, Azure 13,1 %, Deepgram Nova-2 13,8 %, Google Chirp 2 20,6 %. Ingen tjänst erbjuder känsloanalys ur ljud; alla "sentiment"-funktioner är textbaserade.

**Kostnad för ett tvåtimmarsmöte:** Speechmatics realtid 0,9–1,6 USD, Soniox 0,24 USD, Deepgram ~1,3 USD, ElevenLabs batch 0,44 USD. Gratiskrediter: Speechmatics 100 USD, Deepgram 200 USD, AssemblyAI 50 USD, ElevenLabs 4,5 h/mån.

**Varför Speechmatics som förstaval:** enda som kombinerar svenska i realtid, diarisering som håller hela sessionen med inställningar (`max_speakers`, `prefer_current_speaker`), EU-endpoint utan enterprise-avtal, browser-JWT och publicerade svenska siffror. Soniox är sex gånger billigare och värt att testa parallellt. ElevenLabs för bästa kvalitet i efterhand, men EU-residens kräver enterprise.

## 4. Juridik

**Spela in möte man deltar i:** lagligt i Sverige. Brottsbalken 4 kap. 9 a § (olovlig avlyssning) träffar bara den som inte själv deltar. Lämna aldrig telefonen inspelande när du går ut ur rummet, då blir det brottsligt. [Riksdagen](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/brottsbalk-1962700_sfs-1962-700/)

**GDPR:** hushållsundantaget gäller inte (arbetsmöte = yrkesmässigt). Om du spelar in i tjänsten är arbetsgivaren ansvarig; gör du det på eget bevåg i privat moln blir du själv personuppgiftsansvarig, vilket är sämsta läget. Rättslig grund i praktiken intresseavvägning (art. 6.1 f), inte samtycke (maktobalans mellan kollegor). Informera innan inspelning (art. 13), respektera invändningar (art. 21). IMY:s enda vägledning om AI-transkribering (sandlåderapport om socialtjänsten, april 2026) kräver information i förväg, mänsklig granskning av varje transkript och tydliga gallringsrutiner med radering av ljudet. [IMY-rapport](https://www.imy.se/globalassets/dokument/rapporter/transkribering-inom-socialtjansten.pdf)

**Talarindelning och biometri:** att klustra röster till A/B/C inom ett möte och själv döpa dem är inte behandling "i syfte att unikt identifiera" och ligger utanför art. 9. Att **spara röstprofiler mellan möten** för att känna igen återkommande personer är biometrisk identifiering (EDPB riktlinjer 02/2021 om röstassistenter: kräver uttryckligt samtycke från alla, inklusive gäster). Därför kastar både appen och referensservern alla embeddings när sessionen är slut. [EDPB 02/2021](https://www.edpb.europa.eu/system/files/2021-07/edpb_guidelines_202102_on_vva_v2.0_adopted_en.pdf)

**Känsloanalys, AI-förordningen art. 5.1 f:** förbjudet att använda AI för att dra slutsatser om känslor hos personer på arbetsplatsen, i kraft sedan 2 februari 2025. Kommissionens riktlinjer (C(2025) 884, 4 feb 2025): röstdrag som höjd röst är "uppenbara uttryck", men så fort de används för slutsatsen "arg/glad" är det känsloigenkänning (p. 249); "arbetsplats" tolkas brett (p. 254); exemplet "AI som övervakar den känslomässiga tonen i hybridteam ur röst och bild från möten" är uttryckligen förbjudet, även i konfliktförebyggande syfte; alla deployers omfattas, och enskilda i yrkesroll räknas som deployers (p. 34). Undantag bara för medicinska skäl och säkerhet, inte välmående eller stress. Att analysera **kunders** känslor faller utanför förbudet men är högrisk (bilaga III) med informationsplikt (art. 50.3 från aug 2026), och i ett blandat möte går kollegor och kunder inte att skilja åt. Sanktion upp till 35 MEUR eller 7 % av omsättningen. IMY är marknadskontrollmyndighet i Sverige. [Riktlinjer](https://ec.europa.eu/newsroom/dae/redirection/document/112367), [art. 5](https://artificialintelligenceact.eu/article/5/)

**Molnlagring:** EU–US Data Privacy Framework gäller (Latombe-överklagande C-703/25 P pågår, dom väntas 2027). Google och Microsoft är certifierade. IMY accepterar överföring till DPF-certifierad mottagare. Använd jobbtenanten (personuppgiftsbiträdesavtal, EU-region), inte privat konsumentkonto. [IMY om USA-överföringar](https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/overforing-till-tredje-land/overforingar-till-usa/)

**Checklista:** informera vid mötesstart (vem, varför, var, hur länge, rätt att invända); dokumentera intresseavvägning eller stäm av med arbetsgivaren; radera ljudet efter granskning; granska transkriptet innan det används; döp talare manuellt, spara aldrig röstprofiler; ingen känsloanalys; spara i jobbkontot.

## 5. Webbläsarteknik

- **Chunkning:** MediaRecorder med `timeslice` ger bitar som inte är självständigt avkodbara (headern ligger bara i första biten); omstart per bit tappar tiotals millisekunder vid varje gräns. Lösning: AudioWorklet → PCM → egen nedsampling till 16 kHz → WAV per minut. Noll glapp, identiskt i alla webbläsare, 1,9 MB/min. [Chromium README](https://crrev.com/fad2769a1af7e86f2d53a17e73439c8ae15142f7/third_party/blink/renderer/modules/mediarecorder/README.md)
- **Bakgrund på telefon:** iOS stänger mikrofonen när skärmen låses, särskilt för hemskärms-appar (ingen fix hittad). Android Chrome dödar fångsten efter ~1 min med släckt skärm. Lösning: Wake Lock (iOS Safari 16.4+, återbegärs vid `visibilitychange`), skärmen tänd, app i förgrunden, laddare i. Inkommande samtal tystar mikrofonen tills omladdning. [WebKit 226620](https://bugs.webkit.org/show_bug.cgi?id=226620)
- **Lagring:** IndexedDB-kvot ~60 % av disk, 230 MB för två timmar är inget problem. Safari raderar all lagring efter 7 dagars inaktivitet på sajten, så ladda upp eller exportera i tid. `navigator.storage.persist()` anropas men beviljas tyst.
- **Google Drive utan backend:** Google Identity Services token-modell, scope `drive.file` är icke-känsligt (ingen Google-granskning). Token lever 1 h utan tyst förnyelse från statisk sida; appen ber om ny inloggning och köar synken lokalt under tiden. Drive saknar append; `files.update` med `uploadType=media` skriver om hela filen (transkriptet är litet). [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- **OneDrive utan backend:** MSAL.js (PKCE, SPA) + `Files.ReadWrite.AppFolder` fungerar för både jobb- och privatkonton utan admin-consent (om tenanten tillåter användarsamtycke); `PUT …/content` upp till 250 MB, uppladdningssession för större. [App folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)
- **Direkt till STT från webbläsaren:** Deepgram (nyckel i WebSocket-subprotokoll), Speechmatics (tillfällig JWT), Soniox (tillfällig nyckel), AssemblyAI (tillfällig token) fungerar med egen nyckel i localStorage. ElevenLabs och Gladia batch behöver CORS-test. Nyckeln är synlig för den som har telefonen upplåst.
- **GitHub Pages:** alltid HTTPS (krävs för mikrofon), 1 GB, inga egna headers (ingen COOP/COEP, så ingen SharedArrayBuffer, därför ingen flertrådad WASM-kodning).

## 6. Öppna frågor att verifiera med riktiga nycklar

1. Speechmatics: om tillfälliga nycklar (`/v1/api_keys?type=rt`) är aktiverade på kontot utan supportärende.
2. Soniox: aktuellt modellnamn för realtid (`stt-rt-preview` är standard i appen, byt i inställningen Modell vid behov) och om talaretiketter håller över långa sessioner.
3. ElevenLabs: om `api.elevenlabs.io/v1/speech-to-text` svarar med CORS-headers för direkta anrop.
4. Deepgram: Nova-3 kontra Nova-2 på svenska; EU-värd kräver att URL:en görs konfigurerbar.
5. Egen server: tröskeln för röstmatchning mellan minutdelar behöver trimmas mot riktiga möten.
