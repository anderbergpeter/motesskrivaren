import './style.css';
import { GoogleDriveStorage } from './cloud/googleDrive';
import { OneDriveStorage } from './cloud/oneDrive';
import type { CloudStorage } from './cloud/types';
import { localConfig, onLocalStatus, preloadLocal, type LocalStatus } from './local/localProvider';
import { providers } from './providers';
import { MeetingController } from './session/controller';
import { loadSettings, saveSettings, type Settings } from './settings';
import { db } from './storage/db';
import { defaultSpeakerNames, formatTime, paragraphs, sessionFileName, speakerKey, toMarkdown, type Session } from './transcript/model';

const SPEAKER_COLORS = ['#38bdf8', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#fb923c', '#2dd4bf', '#f87171', '#c084fc', '#86efac'];

let settings: Settings = loadSettings();
let cloud: CloudStorage | null = null;
let cloudStatus = '';
let cloudOk = true;
let status = { text: '', kind: 'info' as 'info' | 'warn' | 'error' };
let level = 0;
let localStatus: LocalStatus = { text: '', ready: false };
let timer: ReturnType<typeof setInterval> | null = null;

function makeCloud(): CloudStorage | null {
  if (settings.cloud === 'google') return new GoogleDriveStorage(settings.googleClientId);
  if (settings.cloud === 'microsoft') return new OneDriveStorage(settings.microsoftClientId);
  return null;
}

cloud = makeCloud();
const controller = new MeetingController(settings, cloud);

const app = document.getElementById('app')!;

// ---------------------------------------------------------------------------
// Rendering

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Array<Node | string | null | undefined>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

let settingsOpen = false;
let sessionsOpen = false;

function render(): void {
  const session = controller.current;
  const recording = controller.isRecording;
  const parts: Array<HTMLElement | null> = [
    h(
      'header',
      {},
      h('h1', {}, h('img', { src: './favicon.svg', alt: '' }), 'Mötesskrivaren'),
      h('button', { class: 'ghost', onClick: () => ((settingsOpen = !settingsOpen), render()) }, settingsOpen ? 'Stäng' : 'Inställningar'),
    ),
    settingsOpen ? renderSettings() : null,
    renderRecorder(session, recording),
    session ? renderTranscript(session, recording) : null,
    renderSessions(),
    renderLegal(),
  ];
  app.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}

function renderRecorder(session: Session | null, recording: boolean): HTMLElement {
  const titleInput = h('input', {
    type: 'text',
    placeholder: 'Mötets namn (t.ex. Kundmöte Hultafors)',
    value: session && recording ? session.title : lastTitle,
    onInput: (e: Event) => (lastTitle = (e.target as HTMLInputElement).value),
    disabled: recording,
  });
  const provider = providers.find((p) => p.id === settings.providerId);
  const elapsed = recording ? controller.elapsedSeconds : session ? (session.endedAt ? (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000 : 0) : 0;
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'field' }, titleInput),
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'timer grow' }, formatTime(elapsed)),
      h('div', { class: 'status grow' }, `${provider?.label ?? ''}${settings.cloud !== 'none' ? ` · ${settings.cloud === 'google' ? 'Google Drive' : 'OneDrive'}` : ' · bara lokalt'}`),
    ),
    h('div', { class: 'meter', style: 'margin:10px 0' }, h('div', { style: `width:${Math.min(100, level * 300)}%` })),
    recording
      ? h('button', { class: 'big danger', onClick: onStop }, 'Stoppa och spara')
      : h('button', { class: 'big primary', onClick: () => onStart(titleInput.value) }, 'Starta transkribering'),
    h('p', { class: `status ${status.kind}`, style: 'margin-top:10px' }, status.text),
    cloudStatus ? h('p', { class: `status ${cloudOk ? 'ok' : 'warn'}` }, cloudStatus) : null,
    settings.providerId === 'local' && localStatus.text
      ? h(
          'div',
          {},
          h('p', { class: `status ${localStatus.ready ? 'ok' : ''}` }, localStatus.text),
          localStatus.fraction !== undefined && !localStatus.ready
            ? h('div', { class: 'meter', style: 'margin-top:4px' }, h('div', { style: `width:${Math.round(localStatus.fraction * 100)}%; background: var(--accent)` }))
            : null,
        )
      : null,
    session && session.chunks.length
      ? h(
          'div',
          { class: 'chunks', title: 'Ljuddelar: grå = väntar, gul = skickad, grön = klar, röd = misslyckad (klicka för att försöka igen)' },
          ...session.chunks.map((c) =>
            h('button', {
              class: `chunk ${c.status}`,
              title: `Del ${c.index + 1} (${formatTime(c.startSec)}) – ${c.status}${c.error ? ': ' + c.error : ''}`,
              onClick: c.status === 'failed' ? () => controller.retryChunk(c.index).catch(showError) : undefined,
            }),
          ),
        )
      : null,
  );
}

let lastTitle = '';

function renderTranscript(session: Session, recording: boolean): HTMLElement {
  const defaults = defaultSpeakerNames(session.segments);
  const colorFor = new Map<string, string>();
  const keyOrder: string[] = [];
  for (const seg of [...session.segments].sort((a, b) => a.start - b.start)) {
    const k = speakerKey(seg);
    if (!colorFor.has(k)) {
      colorFor.set(k, SPEAKER_COLORS[keyOrder.length % SPEAKER_COLORS.length]);
      keyOrder.push(k);
    }
  }
  const paras = paragraphs(session);
  // Map display name -> first key with that name, for renaming from a paragraph.
  const keyByName = new Map<string, string>();
  for (const seg of session.segments) {
    const k = speakerKey(seg);
    const name = session.speakerNames[k] ?? defaults.get(k) ?? seg.speaker;
    if (!keyByName.has(name)) keyByName.set(name, k);
  }
  const provider = providers.find((p) => p.id === session.providerId);
  const chunkScoped = provider?.kind === 'batch' && provider.speakerScope === 'chunk' && !session.finalPassDone;

  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'row', style: 'margin-bottom:10px' },
      h('strong', { class: 'grow' }, session.title),
      h('button', { onClick: () => download(session) }, 'Ladda ner .md'),
      h('button', { onClick: () => navigator.clipboard.writeText(toMarkdown(session)).then(() => setStatus('Kopierat')) }, 'Kopiera'),
    ),
    chunkScoped
      ? h(
          'div',
          { class: 'notice', style: 'margin-bottom:10px' },
          'Den här leverantören ger talare per minutdel ("Talare A (del 3)"). ',
          recording
            ? 'När mötet är slut kan du köra en helfilsanalys för konsekventa talare.'
            : h('button', { onClick: () => controller.fullFilePass().catch(showError), disabled: recording }, 'Kör helfilsanalys'),
        )
      : null,
    paras.length === 0
      ? h('p', { class: 'empty' }, recording ? 'Lyssnar… texten dyker upp efter första minutdelen.' : 'Inget transkriberat ännu.')
      : h(
          'div',
          { class: 'transcript' },
          ...paras.map((p) => {
            const key = keyByName.get(p.speaker) ?? '';
            return h(
              'div',
              { class: 'turn' },
              h(
                'div',
                { class: 'who' },
                h(
                  'button',
                  {
                    style: `background:${colorFor.get(key) ?? '#64748b'}`,
                    title: 'Klicka för att döpa talaren',
                    onClick: () => {
                      const name = prompt(`Vem är "${p.speaker}"?`, session.speakerNames[key] ?? '');
                      if (name !== null) controller.renameSpeaker(key, name);
                    },
                  },
                  p.speaker,
                ),
                h('time', {}, formatTime(p.start)),
              ),
              h('p', {}, p.text),
            );
          }),
        ),
    !recording && session.chunks.length
      ? h(
          'div',
          { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'ghost', onClick: () => controller.deleteLocalAudio().then(render) }, 'Radera ljudet från enheten'),
        )
      : null,
  );
}

let sessionList: Session[] = [];

function renderSessions(): HTMLElement {
  return h(
    'details',
    { class: 'panel sessions', open: sessionsOpen || undefined, onToggle: (e: Event) => (sessionsOpen = (e.target as HTMLDetailsElement).open) },
    h('summary', {}, `Tidigare möten (${sessionList.length})`),
    sessionList.length === 0
      ? h('p', { class: 'empty' }, 'Inga sparade möten på den här enheten.')
      : h(
          'ul',
          {},
          ...sessionList.map((s) =>
            h(
              'li',
              {},
              h('span', { class: 'grow' }, `${new Date(s.startedAt).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })} – ${s.title}`),
              h('button', { class: 'ghost', onClick: () => controller.load(s), disabled: controller.isRecording }, 'Öppna'),
              h(
                'button',
                {
                  class: 'ghost',
                  onClick: async () => {
                    if (confirm(`Radera "${s.title}" från den här enheten? (Filen i molnet påverkas inte.)`)) {
                      await db.deleteSession(s.id);
                      await refreshSessions();
                    }
                  },
                },
                'Radera',
              ),
            ),
          ),
        ),
  );
}

function renderLegal(): HTMLElement {
  return h(
    'details',
    { class: 'panel' },
    h('summary', {}, 'Innan du spelar in'),
    h(
      'ul',
      { style: 'padding-left:18px; line-height:1.5' },
      h('li', {}, 'Berätta i början av mötet att det spelas in och transkriberas med AI, var texten sparas och hur länge. Stoppa om någon invänder.'),
      h('li', {}, 'Du får spela in möten du själv deltar i (BrB 4 kap. 9 a §), men lämna aldrig telefonen inspelande när du går ut.'),
      h('li', {}, 'Talare A/B/C är bara en gruppering inom ett möte. Appen sparar inga röstprofiler mellan möten, för det skulle vara biometrisk identifiering (GDPR art. 9).'),
      h('li', {}, 'Känslo-/stämningsanalys av röster på arbetsplatsen är förbjuden enligt EU:s AI-förordning (art. 5.1 f) sedan februari 2025. Därför finns den inte i appen.'),
      h('li', {}, 'Radera ljudet när transkriptet är granskat. Transkriptet innehåller personuppgifter: spara det i jobbkontot, inte privat moln.'),
    ),
  );
}

function renderSettings(): HTMLElement {
  const provider = providers.find((p) => p.id === settings.providerId)!;
  const update = (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    saveSettings(settings);
    cloud = makeCloud();
    controller.updateSettings(settings, cloud);
    render();
  };
  const keyInput = h('input', {
    type: 'password',
    placeholder: provider.id === 'selfhosted' ? 'Valfri bearer-token' : 'API-nyckel',
    value: settings.apiKeys[provider.id] ?? '',
    onChange: (e: Event) => update({ apiKeys: { ...settings.apiKeys, [provider.id]: (e.target as HTMLInputElement).value.trim() } }),
    autocomplete: 'off',
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', { style: 'margin:0 0 10px; font-size:1.05rem' }, 'Inställningar'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Transkriberingstjänst'),
      h(
        'select',
        { onChange: (e: Event) => update({ providerId: (e.target as HTMLSelectElement).value, model: '' }) },
        ...providers.map((p) => h('option', { value: p.id, selected: p.id === settings.providerId || undefined }, p.label)),
      ),
      h('p', { class: 'hint' }, providerHint(provider.id)),
      provider.id === 'local'
        ? h(
            'div',
            { class: 'row', style: 'margin-top:8px' },
            h('button', { onClick: () => preloadLocal(localConfig({ language: settings.language, model: settings.model })), disabled: localStatus.ready }, localStatus.ready ? 'Modeller laddade' : 'Ladda ner modeller nu'),
            h('span', { class: 'hint' }, 'Laddas ner en gång och sparas i webbläsaren. Gör det på wifi innan mötet.'),
          )
        : null,
    ),
    !['mock', 'local', 'webspeech'].includes(provider.id)
      ? h('div', { class: 'field' }, h('label', {}, provider.id === 'selfhosted' ? 'Token (valfritt)' : 'API-nyckel (sparas bara i den här webbläsaren)'), keyInput)
      : null,
    provider.id === 'selfhosted'
      ? h(
          'div',
          { class: 'field' },
          h('label', {}, 'Serverns adress'),
          h('input', { type: 'url', placeholder: 'https://min-server.example.com', value: settings.selfHostedUrl, onChange: (e: Event) => update({ selfHostedUrl: (e.target as HTMLInputElement).value.trim() }) }),
        )
      : null,
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        { class: 'field grow' },
        h('label', {}, 'Språk'),
        h(
          'select',
          { onChange: (e: Event) => update({ language: (e.target as HTMLSelectElement).value }) },
          ...[
            ['sv', 'Svenska'],
            ['en', 'Engelska'],
            ['no', 'Norska'],
            ['da', 'Danska'],
            ['fi', 'Finska'],
            ['de', 'Tyska'],
          ].map(([v, l]) => h('option', { value: v, selected: v === settings.language || undefined }, l)),
        ),
      ),
      h(
        'div',
        { class: 'field grow' },
        h('label', {}, 'Minutdelens längd (sekunder)'),
        h('input', { type: 'number', min: 20, max: 600, step: 10, value: settings.chunkSeconds, onChange: (e: Event) => update({ chunkSeconds: Math.max(20, Math.min(600, Number((e.target as HTMLInputElement).value) || 60)) }) }),
      ),
      provider.id === 'local'
        ? h(
            'div',
            { class: 'field grow' },
            h('label', {}, 'Modellstorlek'),
            h(
              'select',
              { onChange: (e: Event) => update({ model: (e.target as HTMLSelectElement).value }) },
              ...[
                ['tiny', 'Tiny – snabbast, ca 90 MB, sämre (WER ~13 %)'],
                ['base', 'Base – rekommenderad, ca 140 MB (WER ~9 %)'],
                ['small', 'Small – bäst, ca 310 MB, kräver GPU/dator (WER ~7 %)'],
              ].map(([v, l]) => h('option', { value: v, selected: v === (settings.model || 'base') || undefined }, l)),
            ),
          )
        : h(
            'div',
            { class: 'field grow' },
            h('label', {}, 'Modell (valfritt)'),
            h('input', { type: 'text', placeholder: 'standard', value: settings.model, onChange: (e: Event) => update({ model: (e.target as HTMLInputElement).value.trim() }) }),
          ),
    ),
    h('h3', { style: 'margin:14px 0 8px; font-size:1rem' }, 'Lagring i molnet'),
    h(
      'div',
      { class: 'field' },
      h(
        'select',
        { onChange: (e: Event) => update({ cloud: (e.target as HTMLSelectElement).value as Settings['cloud'] }) },
        h('option', { value: 'none', selected: settings.cloud === 'none' || undefined }, 'Bara på den här enheten'),
        h('option', { value: 'google', selected: settings.cloud === 'google' || undefined }, 'Google Drive (mapp "Mötesskrivaren")'),
        h('option', { value: 'microsoft', selected: settings.cloud === 'microsoft' || undefined }, 'OneDrive (Appar/Mötesskrivaren)'),
      ),
    ),
    settings.cloud === 'google'
      ? h(
          'div',
          { class: 'field' },
          h('label', {}, 'Google OAuth Client ID'),
          h('input', { type: 'text', placeholder: '1234-abc.apps.googleusercontent.com', value: settings.googleClientId, onChange: (e: Event) => update({ googleClientId: (e.target as HTMLInputElement).value.trim() }) }),
          h('p', { class: 'hint' }, 'Skapa ett OAuth-klient-id (Web application) i Google Cloud Console med den här sidans adress som Authorized JavaScript origin. Scope: drive.file, appen ser bara filer den själv skapat.'),
        )
      : null,
    settings.cloud === 'microsoft'
      ? h(
          'div',
          { class: 'field' },
          h('label', {}, 'Microsoft Entra Application (client) ID'),
          h('input', { type: 'text', placeholder: '00000000-0000-0000-0000-000000000000', value: settings.microsoftClientId, onChange: (e: Event) => update({ microsoftClientId: (e.target as HTMLInputElement).value.trim() }) }),
          h('p', { class: 'hint' }, 'Registrera en app i Entra (Single-page application, redirect = den här sidans adress) med behörigheten Files.ReadWrite.AppFolder.'),
        )
      : null,
    settings.cloud !== 'none'
      ? h(
          'div',
          { class: 'row field' },
          cloud?.isConnected()
            ? h('span', { class: 'status ok grow' }, `Inloggad: ${cloud.accountLabel() ?? ''}`)
            : h('span', { class: 'status grow' }, 'Inte inloggad'),
          cloud?.isConnected()
            ? h('button', { onClick: () => cloud?.disconnect().then(render) }, 'Logga ut')
            : h('button', { class: 'primary', onClick: () => cloud?.connect().then(render).catch(showError) }, 'Logga in'),
        )
      : null,
    settings.cloud !== 'none'
      ? h(
          'label',
          { class: 'row', style: 'color:var(--text)' },
          h('input', { type: 'checkbox', checked: settings.uploadAudio, onChange: (e: Event) => update({ uploadAudio: (e.target as HTMLInputElement).checked }) }),
          'Ladda även upp ljudet (1,9 MB per minut) till en undermapp',
        )
      : null,
  );
}

function providerHint(id: string): string {
  switch (id) {
    case 'local':
      return 'Helt gratis och privat: KB-Whisper (svenska) eller OpenAI Whisper (andra språk) körs i din webbläsare, med lokal röstmatchning för talare A/B/C. Kräver en hyfsat ny telefon eller dator; på svag hårdvara släpar texten efter men kommer ikapp.';
    case 'webspeech':
      return 'Gratis via webbläsarens egen taligenkänning (Google i Chrome, Apple i Safari). Snabb och bra text, men ingen talarindelning.';
    case 'speechmatics':
      return 'Rekommenderas för live. Svenska, EU-servrar, samma talare hela mötet. Ca 9–16 kr per mötestimme. Gratis startkredit.';
    case 'soniox':
      return 'Billigast (ca 1,3 kr per timme), svenska och talare i realtid. EU-region på begäran.';
    case 'deepgram':
      return 'Svenska via Nova-2/Nova-3, talare i realtid. Sätt modell "nova-3" för senaste. EU: byt värd till api.eu.deepgram.com (kräver anpassning).';
    case 'elevenlabs':
      return 'Mycket hög svensk kvalitet, men talare numreras per minutdel. Kör helfilsanalys efteråt för konsekventa talare.';
    case 'openai':
      return 'Experimentell. 25 MB-gräns gör att helfilsanalys inte går. Talare per minutdel.';
    case 'selfhosted':
      return 'Kör KB-Whisper + pyannote på egen GPU-server (se mappen server/ i repot). All data stannar hos dig.';
    default:
      return 'Testläge utan API-nyckel: genererar låtsastext så att du kan prova flödet.';
  }
}

// ---------------------------------------------------------------------------
// Actions

function setStatus(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  status = { text, kind };
  render();
}

function showError(e: unknown): void {
  setStatus(e instanceof Error ? e.message : String(e), 'error');
}

async function onStart(title: string): Promise<void> {
  try {
    if (settings.cloud !== 'none' && cloud && !cloud.isConnected()) {
      // Must happen inside the user gesture.
      await cloud.connect();
    }
    await controller.start(title);
    lastTitle = '';
    timer = setInterval(render, 1000);
    window.addEventListener('beforeunload', beforeUnload);
  } catch (e) {
    showError(e);
  }
}

async function onStop(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('beforeunload', beforeUnload);
  level = 0;
  try {
    await controller.stop();
    await refreshSessions();
  } catch (e) {
    showError(e);
  }
}

function beforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
}

function download(session: Session): void {
  const blob = new Blob([toMarkdown(session)], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = sessionFileName(session);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function refreshSessions(): Promise<void> {
  sessionList = await db.listSessions();
  render();
}

// ---------------------------------------------------------------------------
// Boot

controller.on((e) => {
  if (e.type === 'level') {
    level = e.level;
    const bar = app.querySelector<HTMLElement>('.meter > div');
    if (bar) bar.style.width = `${Math.min(100, level * 300)}%`;
    return;
  }
  if (e.type === 'status') status = { text: e.text, kind: e.kind ?? 'info' };
  if (e.type === 'cloud') {
    cloudStatus = e.text;
    cloudOk = e.ok;
  }
  render();
});

onLocalStatus((s) => {
  localStatus = s;
  render();
});
if (cloud instanceof OneDriveStorage) void cloud.restore().then(render);
render();
void refreshSessions();
