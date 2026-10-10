'use client';

import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { autoSelectAccount } from './account-filter';
import { mediaLabel, mediaTypeLabel, shortCaption, shortId } from './media-label';
import { shouldHandleShortcut, AI_COMPLAINT_HINT, AI_ERROR_LABELS, AI_LOCAL_PRIVACY_NOTE, AI_LOCAL_RESOURCE_NOTE, AI_PRIVACY_NOTICE, AI_WINDOW_LABELS, LOCAL_MODEL_INFO, aiReviewGate, localModelCardState, type DownloadView, type LocalModelEntryView, AUTO_HIDE_OPTIONS, aiJobSummary, aiProgressPercent, aiProgressText, availableActions, bulkAllowed, bulkSummary, categoryLabel, reasonsText, stateLabel as moderationStateLabel, type BulkResultView } from './moderation-labels';
import { autoPickAutomation, describeQueuePayload, type PendingItem, type PendingPage } from './pending-review';
import { GENERAL_MEDIA_OPTION, automationTargetLabel, automationTargetPayload } from './automation-scope';
import { deriveOnboarding, showOnboarding as shouldShowOnboarding } from './onboarding';
import { formatElapsed, progressPercent, progressText, reasonLabel, summarizeScan, type ScanProgressDto } from './scan-summary';
import { DISABLED_FEATURES, ENV_IMPORT_DISABLED_HINT, type Features, legacyPanelAccounts, parseFeatures } from './settings-features';
import { INTERACTIVE_RETIRED_LABEL, directionLabel } from './interactive-buttons';
import { ATTACHMENT_ERROR_LABELS, attachmentErrorHint, attachmentPartStateLabel, attachmentPreviewLine } from './resource-attachment';
// The follow gate and the resource attachment are RETIRED: no form fields or badges; only historical sessions are shown.
import {
  FOLLOW_GATE_RETIRED_LABEL, MEDIA_LINK_TIP, followGateErrorHint, followGateEventLabel, followGateStateLabel, showFollowGateDetail,
} from './follow-gate';
import { House, Plug, PlugZap, Images, Zap, Radio, Inbox, History, Settings2, CheckCircle2, AlertTriangle, XCircle, Circle, Image as ImageIcon, Clapperboard, Layers, RefreshCw, Pencil, Pause, Play, Archive, Trash2, Unplug, Search, ExternalLink, ShieldCheck, ShieldOff, Plus, ChevronRight, ShieldAlert, Eye, EyeOff, Sparkles, KeyRound, Download, Cpu, ChevronsUpDown, FlaskConical, MessageCircleHeart, Menu, X, Siren, ArrowRight, Send, Clock, Flag, Check, ScanEye, Undo2, ListFilter, FileDown, Lock, Rocket, ArrowLeft, BellDot, Users, Sun, Moon, CircleHelp } from 'lucide-react';
import { AiRowSlot, PageActions, SlotContext } from './components/slots';
import { Nani } from './components/Nani';
import { LiveFlow } from './components/LiveFlow';
import { ModerationDeck } from './components/ModerationDeck';
import { type NaniState, accountErrorLabel, accountProblems, coverageLabel, enabledKeywords, flowEntries, heroCopy, naniState, watchedPosts } from './nani-labels';
import { PUBLIC_REPLY_SAMPLE_USERNAME, describePublicReply, parseVariantLines, previewExamples, publicReplyErrorHint, type PublicReplyDto, variantCountLabel } from './public-reply';

type Account = { accountId: string; connectionId: string; username: string; status: string; monitoringPaused: boolean; sendHoldReason?: string | null; last_sync?: string; last_error?: string; coverage?: string };
type Connection = { id: string; name: string; login_kind: string; app_id?: string | null; graph_version: string; status: string; last_validated_at: string | null };
type Media = { accountId: string; mediaId: string; permalink?: string; publishedAt?: string; caption?: string | null; mediaType?: string | null; thumbnailUrl?: string | null };
type ScanJob = { id: string; status: string; createdAt?: string; result?: any; progress?: ScanProgressDto; errorCode?: string };
const SCAN_JOB_KEY = 'social-desk.activeScanJob';
type Automation = { automationId: string; accountId: string; mediaId: string | null; scope?: 'media' | 'account'; name: string; status: string; realEnabled: boolean; keywords: Array<{ phrase: string }>; buttons?: Array<{ title: string; url: string }>; replyText?: string; matchMode?: 'exact' | 'contains'; publicReplyEnabled?: boolean; publicReplyVariants?: string[]; followGateEnabled?: boolean; followGateMessage?: string; followGateButtonTitle?: string; resourceAttachmentKind?: string; resourceAttachmentUrl?: string };
type AttachmentDto = { kind: string; url: string };
type PartDto = { state: string; safeErrorCode: string | null; attempts: number };
type FollowGateSession = { state: string; buttonTitle: string | null; gateSentAt: string | null; tapAt: string | null; windowExpiresAt: string | null; nextPollAt: string | null; pollCount: number; resourceMessageId: string | null; lastErrorCode: string | null; attachment?: AttachmentDto; parts?: { attachment: PartDto; text: PartDto } };
type QueueItem = { id: string; accountId: string; username: string; commentId: string; commentUsername?: string | null; commentText?: string; payload?: { text?: string; buttons?: Array<{ title: string; url: string }>; followGate?: { buttonTitle: string; attachment?: AttachmentDto; resource: { text: string; buttons: Array<{ title: string; url: string }> } } }; state: string; attemptCount: number; messageId: string | null; safeErrorCode: string | null; createdAt: string; publicReply?: PublicReplyDto | null; followGate?: FollowGateSession | null };
type Dashboard = { accounts: Account[]; queue: Array<{ state: string; count: number }>; automations: Array<{ status: string; count: number }>; moderation?: Array<{ state: string; count: number }>; dryRun: boolean; monitoringEnabled: boolean };
/** Moderation flag count for one state (or every state with 'all') from the dashboard payload. */
function flagCount(rows: Dashboard['moderation'], state: string) { return (rows ?? []).filter((row) => state === 'all' || row.state === state).reduce((sum, row) => sum + row.count, 0); }
type Api = (path: string, method?: string, body?: Record<string, unknown>) => Promise<any>;
/** Runs an operation, shows feedback, refreshes data. Resolves true only when the operation succeeded. */
type Act = (operation: () => Promise<unknown>, message: string | (() => string)) => Promise<boolean>;
type ConfirmOptions = { title: string; body: string; confirmLabel: string; danger?: boolean };
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
type Tone = 'good' | 'neutral' | 'warn' | 'danger';

/** Thrown inside an `act` operation when the user declines a confirmation: no feedback, no refresh. */
class Cancelled extends Error {}


const TAB_ICONS: Record<string, any> = { dashboard: House, connections: Plug, media: Images, automations: Zap, moderation: ShieldCheck, monitor: Radio, backlog: Inbox, queue: History, settings: Settings2 };
/** Sidebar grouping (presentational only; the labels of each section never change). */
const NAV_GROUPS: ReadonlyArray<{ label: string | null; ids: readonly string[] }> = [
  { label: null, ids: ['dashboard'] },
  { label: 'Instagram', ids: ['media', 'automations', 'moderation'] },
  { label: 'Actividad', ids: ['monitor', 'backlog', 'queue'] },
  { label: 'Configuración', ids: ['connections', 'settings'] },
];

function RingAvatar({ username, size }: { username?: string | null; size?: 'sm' | 'lg' }) {
  return <div className={size ? `ring-avatar ${size}` : 'ring-avatar'} aria-hidden="true"><div className="ring-avatar-inner">{username ? username[0]!.toUpperCase() : 'V'}</div></div>;
}

const sections = [
  ['dashboard', 'Resumen', 'Vea de un vistazo qué está pasando y qué falta por configurar.'],
  ['connections', 'Conexiones', 'Conecte su token de Meta y elija la cuenta de Instagram que desea administrar.'],
  ['media', 'Publicaciones', 'Publicaciones de la cuenta elegida; se usan para crear automatizaciones.'],
  ['automations', 'Automatizaciones', 'Reglas que responden por mensaje privado a los comentarios con ciertas palabras clave.'],
  ['moderation', 'Moderación', 'Oculte o borre comentarios ofensivos o spam de sus publicaciones; por defecto solo se sugieren.'],
  ['monitor', 'Monitoreo', 'Encienda o apague la vigilancia de comentarios nuevos, por cuenta.'],
  ['backlog', 'Revisión pendiente', 'Revise comentarios anteriores y elija cuáles añadir a la cola; analizar no envía nada.'],
  ['queue', 'Cola e historial', 'Historial de cada respuesta: simulada, enviada, fallida o por revisar.'],
  ['settings', 'Ajustes', 'Modo de envío, importación de configuración y protecciones de seguridad.'],
] as const;

export default function HomePage() {
  const [section, setSection] = useState<string>('dashboard');
  const [csrf, setCsrf] = useState('');
  const [accountFilter, setAccountFilter] = useState('all');
  const [userChoseAccount, setUserChoseAccount] = useState(false);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueOffset, setQueueOffset] = useState(0); const [queueState, setQueueState] = useState('all');
  const [queueTotal, setQueueTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [candidates, setCandidates] = useState<Array<{ connectionId: string; providerAccountId: string; username: string }>>([]);
  const [scanJob, setScanJob] = useState<ScanJob | null>(null);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve(value: boolean): void }) | null>(null);
  const [features, setFeatures] = useState<Features>(DISABLED_FEATURES);
  // Presentational only: mobile drawer and the element that hosts each page's topbar actions.
  const [navOpen, setNavOpen] = useState(false);
  const [queueScope, setQueueScope] = useState('');
  // Presentational: Nani hops for a moment after a success (a reply shows up in the flow, the deck is cleared).
  const [happy, setHappy] = useState(false);
  const happyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrate = useCallback(() => {
    setHappy(true);
    if (happyTimer.current) clearTimeout(happyTimer.current);
    happyTimer.current = setTimeout(() => setHappy(false), 1300);
  }, []);
  const [topbarSlot, setTopbarSlot] = useState<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  // Mobile drawer: focus moves in on open, Tab is trapped, Escape closes from anywhere, focus returns to the menu button.
  useEffect(() => {
    if (!navOpen) {
      if (drawerWasOpen.current) menuButtonRef.current?.focus();
      drawerWasOpen.current = false;
      return;
    }
    drawerWasOpen.current = true;
    const node = sidebarRef.current;
    node?.querySelector<HTMLElement>('.nav-item')?.focus();
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); setNavOpen(false); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = focusableIn(node);
      if (!items.length) return;
      const first = items[0]!; const last = items[items.length - 1]!;
      if (!node.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    // Growing past the mobile breakpoint closes the drawer so the page is never left inert.
    const wide = window.matchMedia('(min-width: 761px)');
    const onWide = () => { if (wide.matches) setNavOpen(false); };
    wide.addEventListener('change', onWide);
    return () => { document.removeEventListener('keydown', onKey); wide.removeEventListener('change', onWide); };
  }, [navOpen]);

  const confirm = useCallback<Confirm>((options) => new Promise<boolean>((resolve) => setDialog({ ...options, resolve })), []);
  function settleDialog(value: boolean) { dialog?.resolve(value); setDialog(null); }

  const api = useCallback<Api>(async (path, method = 'GET', body) => {
    const response = await fetch(path, { method, cache: 'no-store', headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      // The session token goes on every call: mutations require it, and so does the experimental diagnostics GET.
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'request_failed');
    return data;
  }, [csrf]);

  const refresh = useCallback(async () => {
    if (!csrf) return;
    setLoading(true); setError('');
    try {
      const suffix = accountFilter === 'all' ? '' : `?accountId=${encodeURIComponent(accountFilter)}`;
      const queueQuery = new URLSearchParams({ ...(accountFilter === 'all' ? {} : { accountId: accountFilter }), ...(queueState === 'all' ? {} : { state: queueState }), limit: '50', offset: String(queueOffset) });
      const [home, conn, mediaResult, autoResult, queueResult] = await Promise.all([
        api(`/api/dashboard${suffix}`), api(`/api/connections${suffix}`), api(`/api/media${suffix}`), api(`/api/automations${suffix}`),
        api(`/api/queue?${queueQuery}`),
      ]);
      setDashboard(home); setConnections(conn.connections); setAccounts(home.accounts); if (accountFilter === 'all') setAllAccounts(home.accounts); setMedia(mediaResult.media);
      setAutomations(autoResult.automations); setQueue(queueResult.items); setQueueTotal(queueResult.total);
      // Presentational: which account/page the loaded queue belongs to (the live flow restarts without animating on change).
      setQueueScope(`${accountFilter}|${queueState}|${queueOffset}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'request_failed'); }
    finally { setLoading(false); }
  }, [accountFilter, api, csrf, queueOffset, queueState]);

  useEffect(() => { void fetch('/api/session', { cache: 'no-store' }).then((r) => r.json()).then((value) => setCsrf(value.csrfToken ?? '')).catch(() => setError('No se pudo iniciar la sesión local.')); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // Optional features (opt-in by environment variables); unknown or failed answers keep them disabled.
  useEffect(() => { if (!csrf) return; void api('/api/settings/features').then((value) => setFeatures(parseFeatures(value))).catch(() => setFeatures(DISABLED_FEATURES)); }, [api, csrf]);
  // A single account is selected for the user once; an explicit later choice (even "all") is never overridden.
  useEffect(() => {
    const id = autoSelectAccount({ filter: accountFilter, userChose: userChoseAccount, accountIds: allAccounts.map((item) => item.accountId) });
    if (id) { setQueueOffset(0); setAccountFilter(id); }
  }, [accountFilter, allAccounts, userChoseAccount]);
  const chooseAccount = useCallback((value: string) => { setUserChoseAccount(true); setQueueOffset(0); setAccountFilter(value); }, []);
  // Resume polling after a reload: only the job id is remembered (session scope), never any scan data.
  const resumedJob = useRef(false);
  useEffect(() => {
    if (!csrf || resumedJob.current) return;
    resumedJob.current = true;
    let id: string | null = null;
    try { id = sessionStorage.getItem(SCAN_JOB_KEY); } catch { id = null; }
    if (!id) return;
    void api(`/api/backlog/jobs/${id}`).then((value) => setScanJob(value)).catch(() => { try { sessionStorage.removeItem(SCAN_JOB_KEY); } catch { /* storage unavailable */ } });
  }, [api, csrf]);
  const scanJobId = scanJob?.id; const scanJobStatus = scanJob?.status;
  useEffect(() => {
    try {
      // Do nothing before a job is known: clearing here would wipe the id before the resume effect can use it.
      if (!scanJobId) return;
      if (scanJobStatus === 'running') sessionStorage.setItem(SCAN_JOB_KEY, scanJobId);
      else sessionStorage.removeItem(SCAN_JOB_KEY);
    } catch { /* storage unavailable: resume is best-effort */ }
  }, [scanJobId, scanJobStatus]);
  useEffect(() => {
    if (!scanJob || scanJob.status !== 'running') return;
    const poll = () => { void api(`/api/backlog/jobs/${scanJob.id}`).then((value) => setScanJob(value)).catch(() => setError('No se pudo consultar el análisis.')); };
    const timer = setInterval(poll, 1200);
    return () => clearInterval(timer);
  }, [api, scanJob?.id, scanJob?.status]);
  // Success feedback fades by itself; errors stay until dismissed.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const act = useCallback<Act>(async (operation, message) => {
    setError(''); setNotice('');
    try { await operation(); setNotice(typeof message === 'function' ? message() : message); await refresh(); return true; }
    catch (cause) {
      if (cause instanceof Cancelled) return false;
      setError(cause instanceof Error ? cause.message : 'operation_failed');
      return false;
    }
  }, [refresh]);

  // Real mode is only ever shown when the server explicitly said dryRun === false.
  const mode: 'checking' | 'dry' | 'real' = dashboard?.dryRun === true ? 'dry' : dashboard?.dryRun === false ? 'real' : 'checking';
  const current = sections.find(([id]) => id === section) ?? sections[0];
  const accountLabel = accountFilter === 'all' ? 'Todas las cuentas' : `@${accounts.find((item) => item.accountId === accountFilter)?.username ?? 'Cuenta'}`;

  async function toggleDryRun() {
    if (!dashboard || mode === 'checking') return;
    const enabled = !dashboard.dryRun;
    if (!enabled && !(await confirm({
      title: 'Desactivar Dry Run',
      body: 'Desactivar Dry Run permite respuestas privadas reales únicamente en automatizaciones habilitadas. No se enviará nada de la cola simulada anterior.',
      confirmLabel: 'Desactivar Dry Run', danger: true,
    }))) return;
    await act(() => api('/api/settings/dry-run', 'POST', { enabled, confirmed: !enabled }), enabled ? 'Dry Run quedó activo.' : 'Modo real habilitado; no se procesó la cola simulada.');
  }

  const selectedUsername = accounts.find((item) => item.accountId === accountFilter)?.username ?? allAccounts.find((item) => item.accountId === accountFilter)?.username;
  const accountTotal = (allAccounts.length ? allAccounts : accounts).length;
  function go(id: string) { setSection(id); setNavOpen(false); }
  const pendingFlags = flagCount(dashboard?.moderation, 'PENDING');
  const reviewItems = (dashboard?.queue ?? []).filter((row) => row.state === 'UNKNOWN_OUTCOME' || row.state === 'FAILED_PERMANENT').reduce((sum, row) => sum + row.count, 0);
  const problems = accountProblems(accounts);
  const dataState = naniState({ monitoringEnabled: dashboard?.monitoringEnabled ?? false, pendingFlags, reviewItems, accountProblems: problems.length });
  const nani: NaniState = happy ? 'happy' : dataState;

  return <SlotContext.Provider value={{ topbar: topbarSlot, aiRow: null }}>
    <div className={navOpen ? 'app nav-open' : 'app'}>
      <aside className="sidebar" id="app-sidebar" ref={sidebarRef} aria-label="Menú">
        <div className="brand"><Nani state={nani} size={30} decorative className="brand-nani" /><span className="brand-name">nanichat</span>
          <button type="button" className="btn-icon ghost drawer-close" aria-label="Cerrar menú" onClick={() => setNavOpen(false)}><X size={18} /></button></div>
        <label className="account-switch">
          <RingAvatar username={selectedUsername} />
          <span className="account-switch-text"><b>{accountFilter === 'all' ? 'Todas las cuentas' : `@${selectedUsername ?? 'Cuenta'}`}</b><small>{accountTotal} {accountTotal === 1 ? 'cuenta' : 'cuentas'}</small></span>
          <ChevronsUpDown size={16} aria-hidden="true" className="account-switch-icon" />
          <select aria-label="Filtrar por cuenta" value={accountFilter} onChange={(event) => chooseAccount(event.target.value)}><option value="all">Todas las cuentas</option>{(allAccounts.length ? allAccounts : accounts).map((account) => <option key={account.accountId} value={account.accountId}>@{account.username}</option>)}</select>
        </label>
        <nav className="side-nav" aria-label="Navegación principal">
          {NAV_GROUPS.map((group) => <div className="nav-group" key={group.label ?? 'top'}>
            {group.label && <span className="nav-label">{group.label}</span>}
            {group.ids.map((id) => {
              const entry = sections.find(([sectionId]) => sectionId === id)!;
              const Icon = TAB_ICONS[id] || Circle;
              return <button key={id} type="button" className={section === id ? 'nav-item active' : 'nav-item'} aria-current={section === id ? 'page' : undefined} onClick={() => go(id)} aria-label={id === 'moderation' && pendingFlags > 0 ? `${entry[1]}, ${pendingFlags} pendientes` : undefined}><Icon size={17} strokeWidth={1.9} aria-hidden="true" /><span>{entry[1]}</span>{id === 'monitor' && <i className={dashboard?.monitoringEnabled ? 'nav-dot on' : 'nav-dot'} aria-hidden="true" />}{id === 'moderation' && pendingFlags > 0 && <i className="nav-count" data-count={pendingFlags > 99 ? '99+' : String(pendingFlags)} aria-hidden="true" />}</button>;
            })}
          </div>)}
        </nav>
        <div className={`mode-block ${mode}`}>
          <span className="mode-block-head">
            <span className="mode-block-icon" aria-hidden="true">{mode === 'real' ? <Siren size={16} /> : <FlaskConical size={16} />}</span>
            {mode === 'checking'
              ? <button className="mode-pill checking-pill" disabled aria-disabled="true">Verificando modo…</button>
              : <button className={mode === 'dry' ? 'mode-pill dry-pill' : 'mode-pill real-pill'} title={mode === 'dry' ? 'Cambiar a modo real (pide confirmación)' : 'Volver a Dry Run'} onClick={() => void toggleDryRun()}>{mode === 'dry' ? 'Dry Run · Activo' : 'Modo real · Activo'}</button>}
          </span>
          <p>{mode === 'dry' ? 'Nani practica: simula las respuestas, no envía nada a Instagram.' : mode === 'real' ? 'Nani envía mensajes privados reales a Instagram.' : 'Un momento…'}</p>
        </div>
      </aside>
      <button type="button" className="nav-scrim" aria-label="Cerrar menú" tabIndex={-1} onClick={() => setNavOpen(false)} />
      <main className="page" inert={navOpen || undefined}>
        <header className="topbar">
          <button type="button" ref={menuButtonRef} className="btn-icon ghost menu-button" aria-label="Abrir menú" aria-controls="app-sidebar" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu size={18} /></button>
          <div className="topbar-title"><h1>{current[1]}</h1><p className="topbar-sub">{current[2]}</p></div>
          <div className="topbar-actions" ref={setTopbarSlot} />
        </header>
        <div className={`mode-banner ${mode}`}>
          {mode === 'checking' && <span>Verificando el modo de envío…</span>}
          {mode === 'dry' && <><ShieldCheck size={15} aria-hidden="true" /> <span><strong>Modo prueba:</strong> la app analiza y simula, no envía mensajes reales</span></>}
          {mode === 'real' && <><Siren size={15} aria-hidden="true" /> <span><strong>Modo real:</strong> se enviarán mensajes privados reales en automatizaciones autorizadas</span></>}
        </div>
        {loading && <div className="loading-line" role="status"><span>Actualizando datos locales…</span></div>}
        <div className={`content content-${section}`}>
          {section === 'dashboard' && <DashboardView data={dashboard} accounts={accounts} connections={connections} automations={automations} queue={queue} mode={mode} nani={nani} pendingFlags={pendingFlags} reviewItems={reviewItems} accountFilter={accountFilter} accountCount={allAccounts.length} accountLabel={accountLabel} queueFiltered={queueState !== 'all' || queueOffset > 0} queueScope={queueScope} onNavigate={setSection} onRefresh={() => void refresh()} onCelebrate={celebrate} api={api} act={act} />}
          {section === 'connections' && <ConnectionsView connections={connections} accounts={accounts} candidates={candidates} setCandidates={setCandidates} api={api} act={act} confirm={confirm} features={features} />}
          {section === 'media' && <MediaView accounts={accounts} allAccounts={allAccounts} onSelectAccount={chooseAccount} media={media} selected={accountFilter} onNavigate={setSection} api={api} act={act} />}
          {section === 'automations' && <AutomationView accounts={accounts} media={media} rows={automations} selected={accountFilter} api={api} act={act} confirm={confirm} />}
          {section === 'moderation' && <ModerationView onCelebrate={celebrate} flagCounts={dashboard?.moderation} accountFilter={accountFilter} allAccounts={allAccounts} onSelectAccount={chooseAccount} onNavigate={setSection} api={api} act={act} confirm={confirm} mode={mode} />}
          {section === 'monitor' && <MonitorView accounts={accounts} status={dashboard?.monitoringEnabled ?? false} onNavigate={setSection} api={api} act={act} />}
          {section === 'backlog' && <BacklogView allAccounts={allAccounts} accounts={accounts} onSelectAccount={chooseAccount} selected={accountFilter} job={scanJob} setJob={setScanJob} rows={automations} api={api} act={act} confirm={confirm} />}
          {section === 'queue' && <QueueView items={queue} total={queueTotal} offset={queueOffset} setOffset={setQueueOffset} state={queueState} setState={(value) => { setQueueOffset(0); setQueueState(value); }} onNavigate={setSection} api={api} act={act} />}
          {section === 'settings' && <SettingsView mode={mode} act={act} api={api} confirm={confirm} features={features} />}
        </div>
        {section !== 'moderation' && <footer className="footer-note"><span><span className="status-dot" aria-hidden="true" /> Solo en este equipo · Datos y credenciales permanecen en el servidor local.</span><button className="btn-link" onClick={() => void refresh()}>Actualizar</button></footer>}
      </main>
    </div>
    <div className="toast-region">
      <div role="alert" aria-live="assertive" aria-atomic="true"><ToastItem kind="error" content={error ? <><strong>La acción no se completó</strong><span>{safeErrorLabel(error)}</span></> : null} closeLabel="Cerrar aviso de error" onClose={() => setError('')} /></div>
      <div role="status" aria-live="polite" aria-atomic="true"><ToastItem kind="success" content={notice ? <span>{notice}</span> : null} closeLabel="Cerrar aviso" onClose={() => setNotice('')} /></div>
    </div>
    {dialog && <ConfirmDialog options={dialog} onResult={settleDialog} />}
  </SlotContext.Provider>;
}

/** One toast slot with an exit transition: the last content stays on screen (without the .toast class) while leaving. */
function ToastItem({ kind, content, closeLabel, onClose }: { kind: 'error' | 'success'; content: ReactNode | null; closeLabel: string; onClose(): void }) {
  const [leaving, setLeaving] = useState<ReactNode | null>(null);
  const last = useRef<ReactNode | null>(null);
  useEffect(() => {
    if (content) { last.current = content; setLeaving(null); return; }
    if (!last.current) return;
    setLeaving(last.current); last.current = null;
    const timer = setTimeout(() => setLeaving(null), 200);
    return () => clearTimeout(timer);
  }, [content]);
  if (content) return <div className={`toast ${kind}`}><div>{content}</div><button onClick={onClose} aria-label={closeLabel}>×</button></div>;
  return leaving ? <div className={`toast-leaving ${kind}`} aria-hidden="true"><div>{leaving}</div><span className="toast-x">×</span></div> : null;
}

/** Start or stop monitoring for every validated account: shared by Monitoreo and the Resumen wake button. */
function monitorAll(api: Api, act: Act, action: 'start' | 'stop') {
  return action === 'start'
    ? act(() => api('/api/monitor/all', 'POST', { action: 'start' }), 'Monitoreo iniciado para cuentas validadas.')
    : act(() => api('/api/monitor/all', 'POST', { action: 'stop' }), 'Todo el monitoreo se detuvo.');
}

/* ---------- Dialogs ---------- */

function focusableIn(node: HTMLElement) {
  return Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
}

/** Accessible modal shell: aria-modal, Escape closes, Tab is trapped, focus is restored on close. */
function Modal({ titleId, descriptionId, onClose, children, wide }: { titleId: string; descriptionId?: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node) (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(node)[0])?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = focusableIn(ref.current);
    if (!items.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="modal-backdrop"><div ref={ref} className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={onKeyDown}>{children}</div></div>;
}

function ConfirmDialog({ options, onResult }: { options: ConfirmOptions; onResult(value: boolean): void }) {
  return <Modal titleId="confirm-title" descriptionId="confirm-body" onClose={() => onResult(false)}>
    <h2 id="confirm-title">{options.title}</h2>
    <p id="confirm-body">{options.body}</p>
    <div className="modal-actions">
      {/* Dangerous actions focus Cancel first so Enter never confirms by accident. */}
      <button type="button" className="btn" data-autofocus={options.danger ? '' : undefined} onClick={() => onResult(false)}>Cancelar</button>
      <button type="button" className={options.danger ? 'button danger-solid' : 'button primary'} data-autofocus={options.danger ? undefined : ''} onClick={() => onResult(true)}>{options.confirmLabel}</button>
    </div>
  </Modal>;
}

/* ---------- Views ---------- */

function greeting(now = new Date()) { const hour = now.getHours(); return hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'; }

/** DM bubble text for previews: the same sample substitution the creation form uses. */
function sampleReply(text: string | undefined, keyword?: string) {
  return (text ?? '').replace(/{{username}}/g, 'ana').replace(/{{keyword}}/g, keyword || 'palabra');
}

/** Count-up runs once per page load, the first time Resumen shows real numbers. */
let statsCounted = false;
function CountUp({ value }: { value: number }) {
  // The number is written through the ref only (React renders no text child), so React never holds a stale text node.
  const ref = useRef<HTMLSpanElement>(null);
  const animate = useRef(!statsCounted);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!animate.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches || value === 0) { node.textContent = String(value); return; }
    animate.current = false;
    const start = performance.now(); let frame = 0;
    const step = (now: number) => { const k = Math.min(1, (now - start) / 900); node.textContent = String(Math.round(value * (1 - Math.pow(1 - k, 3)))); if (k < 1) frame = requestAnimationFrame(step); };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); node.textContent = String(value); };
  }, [value]);
  return <span ref={ref} className="stat-v" aria-label={String(value)} />;
}

function DashboardView({ data, accounts, connections, automations, queue, mode, nani, pendingFlags, reviewItems, accountFilter, accountCount, accountLabel, queueFiltered, queueScope, onNavigate, onRefresh, onCelebrate, api, act }: { data: Dashboard | null; accounts: Account[]; connections: Connection[]; automations: Automation[]; queue: QueueItem[]; mode: 'checking' | 'dry' | 'real'; nani: NaniState; pendingFlags: number; reviewItems: number; accountFilter: string; accountCount: number; accountLabel: string; queueFiltered: boolean; queueScope: string; onNavigate(id: string): void; onRefresh(): void; onCelebrate(): void; api: Api; act: Act }) {
  useEffect(() => { if (data) statsCounted = true; }, [data]);
  if (!data) return <Empty title="Cargando datos locales…" detail="Si este mensaje no desaparece, revise que la aplicación local siga en ejecución." />;
  const total = (states: string[]) => data.queue.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.count, 0);
  const onboarding = deriveOnboarding({ connections, accounts, automations, monitoringEnabled: data.monitoringEnabled });
  const problems = accountProblems(accounts);
  const dataState = naniState({ monitoringEnabled: data.monitoringEnabled, pendingFlags, reviewItems, accountProblems: problems.length });
  const copy = heroCopy({ state: dataState, watch: watchedPosts(automations), pendingFlags, reviewItems, problem: problems[0] ?? null });
  const keywords = enabledKeywords(automations);
  const shown = keywords.slice(0, 5);
  const sleeping = !data.monitoringEnabled;
  return <>
    <PageActions><button className="btn" aria-label="Actualizar datos" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" /> <span className="btn-label">Actualizar datos</span></button></PageActions>
    <section className={`hero ${dataState}`} aria-labelledby="hero-say">
      <div className="hero-avatar"><span className="hero-glow" aria-hidden="true" /><Nani state={nani} size={180} follow /></div>
      <div className="speech">
        <h2 className="say" id="hero-say" key={dataState}>{copy.lead}<em>{copy.accent}</em>{copy.tail}</h2>
        <p>{shown.length ? <>Cuando alguien comente {shown.map((keyword, index) => <span key={keyword}>{index > 0 && (index === shown.length - 1 && keywords.length <= 5 ? ' o ' : ', ')}<span className="kw-chip">{keyword}</span></span>)}{keywords.length > 5 ? ` y ${keywords.length - 5} más` : ''}, le escribo por privado.{mode === 'real' ? ' Estoy en modo real: envío de verdad.' : ' En modo prueba solo lo simulo.'}</> : 'Aún no tengo palabras clave: crea una automatización activa y sabré qué responder.'}</p>
        <div className="hero-actions">
          {copy.target && <button className="button primary big" onClick={() => onNavigate(copy.target!)}><ShieldAlert size={17} aria-hidden="true" /> {copy.target === 'moderation' ? 'Revisar comentarios' : copy.target === 'connections' ? 'Revisar conexión' : 'Revisar envíos'}</button>}
          {sleeping
            ? <button className={copy.target ? 'btn big' : 'button primary big'} onClick={() => void monitorAll(api, act, 'start')}><Sun size={17} aria-hidden="true" /> Despertar a Nani</button>
            : <button className="btn big" onClick={() => void monitorAll(api, act, 'stop')}><Moon size={17} aria-hidden="true" /> Dormir a Nani</button>}
          <button className="btn big ghost" onClick={() => onNavigate('automations')}><Zap size={17} aria-hidden="true" /> Ver lo que respondo</button>
        </div>
      </div>
    </section>
    <p className="scope-line">Cifras de <strong>{accountLabel}</strong></p>
    <div className="stats stagger">
      <div className="stat mint"><CountUp value={total(['SENT'])} /><span className="stat-l"><Send size={14} aria-hidden="true" /> Enviadas</span></div>
      <div className="stat lilac"><CountUp value={total(['QUEUED', 'FAILED_RETRYABLE'])} /><span className="stat-l"><Clock size={14} aria-hidden="true" /> En cola</span></div>
      <div className="stat pink"><CountUp value={pendingFlags} /><span className="stat-l"><ShieldAlert size={14} aria-hidden="true" /> Por revisar</span></div>
      <div className="stat sun"><CountUp value={reviewItems} /><span className="stat-l"><CircleHelp size={14} aria-hidden="true" /> Sin confirmar</span></div>
      <div className="stat muted-stat"><CountUp value={total(['EXPIRED'])} /><span className="stat-l"><History size={14} aria-hidden="true" /> Expirados (&gt; 7 días)</span></div>
    </div>
    {accounts.length > 0 && <section aria-labelledby="accounts-title" className="account-strip-section">
      <h3 id="accounts-title" className="sec-title small">Estado por cuenta</h3>
      <div className="account-strip stagger">{accounts.map((account) => {
        const problem = problems.find((item) => item.username === account.username);
        const state: NaniState = problem ? 'alert' : !data.monitoringEnabled || account.monitoringPaused ? 'sleep' : 'awake';
        return <article className={problem ? 'account-card problem' : 'account-card'} key={account.accountId}>
          <Nani state={state} size={40} />
          <div className="account-card-text">
            <strong>@{account.username}</strong>
            <span className="muted">{account.last_sync ? <>Sincronizada <span className="mono nowrap">{formatDate(account.last_sync)}</span></> : 'Sin sincronización'}{coverageLabel(account.coverage) ? ` · ${coverageLabel(account.coverage)}` : ''}</span>
            {account.last_error && <span className="account-error"><AlertTriangle size={13} aria-hidden="true" /> {accountErrorLabel(account.last_error)}</span>}
          </div>
        </article>;
      })}</div>
    </section>}
    {shouldShowOnboarding({ allDone: onboarding.allDone, filter: accountFilter, accountCount }) && <section className="box onboarding" aria-labelledby="onboarding-title">
      <div className="box-h"><Nani state="awake" size={28} decorative /><h3 id="onboarding-title">Primeros pasos</h3><span className="box-h-note">Me faltan {onboarding.steps.filter((step) => step.state !== 'done').length} de {onboarding.steps.length} pasos para trabajar sola · {onboarding.steps.filter((step) => step.state === 'done').length} de {onboarding.steps.length} listos</span></div>
      <ol className="steps">{onboarding.steps.map((step, index) => <li key={step.id} className={`step ${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
        <span className="num" aria-hidden="true">{step.state === 'done' ? <Check size={13} strokeWidth={3} /> : index + 1}</span>
        <div className="step-text"><strong>{step.label}<span className="visually-hidden"> — {step.state === 'done' ? 'listo' : step.state === 'current' ? 'siguiente paso' : 'pendiente'}</span></strong><span className="muted">{step.detail}</span>
          <button className={step.state === 'current' ? 'button primary small' : 'btn-link text-button'} onClick={() => onNavigate(step.target)}>{step.state === 'done' ? 'Revisar' : step.actionLabel}</button></div>
      </li>)}</ol>
    </section>}
    <LiveFlow key={queueScope} entries={flowEntries(queue, keywords, 6)} nani={nani} sleeping={sleeping} stateLabel={stateLabel} onReply={onCelebrate} partial={queueFiltered} />
  </>;
}

function focusById(id: string) { const node = document.getElementById(id); node?.scrollIntoView?.({ block: 'center' }); node?.focus(); }

function ConnectionsView({ connections, accounts, candidates, setCandidates, api, act, confirm, features }: { connections: Connection[]; accounts: Account[]; candidates: Array<{ connectionId: string; providerAccountId: string; username: string }>; setCandidates(value: Array<{ connectionId: string; providerAccountId: string; username: string }>): void; api: Api; act: Act; confirm: Confirm; features: Features }) {
  const legacyAccounts = legacyPanelAccounts(features, accounts);
  const [name, setName] = useState(''); const [loginKind, setLoginKind] = useState('instagram_login'); const [appId, setAppId] = useState(''); const [version, setVersion] = useState('v26.0'); const [token, setToken] = useState('');
  const [editing, setEditing] = useState<Connection | null>(null); const [editName, setEditName] = useState(''); const [editAppId, setEditAppId] = useState(''); const [editVersion, setEditVersion] = useState(''); const [editToken, setEditToken] = useState('');
  async function create(event: FormEvent) { event.preventDefault(); const submittedToken = token; setToken(''); await act(async () => { await api('/api/connections', 'POST', { id: crypto.randomUUID(), name, loginKind, appId, graphVersion: version, accessToken: submittedToken }); setName(''); }, 'Conexión guardada; valide para descubrir cuentas.'); }
  async function discover(id: string) { await act(async () => { await api(`/api/connections/${id}/test`, 'POST', {}); const result = await api(`/api/connections/${id}/discover`, 'POST', {}); setCandidates(result.candidates.map((candidate: any) => ({ ...candidate, connectionId: id }))); }, 'Validación y descubrimiento completados.'); }
  async function update(event: FormEvent) { event.preventDefault(); if (!editing) return; const submittedToken = editToken; setEditToken(''); await act(async () => { await api(`/api/connections/${editing.id}`, 'PUT', { name: editName, appId: editAppId || null, graphVersion: editVersion, ...(submittedToken ? { accessToken: submittedToken } : {}) }); setEditing(null); }, 'Conexión actualizada. Vuelva a validar antes de monitorear.'); }
  async function disconnect(connection: Connection) {
    if (!(await confirm({ title: `Desconectar «${connection.name}»`, body: 'La conexión dejará de leer comentarios y de enviar respuestas. El historial se conserva.', confirmLabel: 'Desconectar', danger: true }))) return;
    await act(() => api(`/api/connections/${connection.id}/disconnect`, 'POST', {}), 'Conexión desconectada; el historial se conserva.');
  }
  async function remove(connection: Connection) {
    if (!(await confirm({ title: `Eliminar «${connection.name}»`, body: 'Eliminar la conexión la desconecta y conserva el historial. Para usarla otra vez tendrá que crear una conexión nueva.', confirmLabel: 'Eliminar conexión', danger: true }))) return;
    await act(() => api(`/api/connections/${connection.id}/delete`, 'POST', {}), 'Conexión eliminada; el historial se conserva.');
  }
  async function acknowledgeLegacy(account: Account) {
    await act(async () => {
      const state = await api(`/api/settings/legacy?username=${encodeURIComponent(account.username)}`);
      if (state.lockPresent) throw new Error('legacy_lock_present');
      if (!(await confirm({ title: `Reconocer historial de @${account.username}`, body: `Confirma que revisó el historial previo y que el contador no cambió para @${account.username}. Se guardará un reconocimiento de seguridad; no se modifica ningún archivo externo.`, confirmLabel: 'Reconocer historial' }))) throw new Cancelled();
      await api('/api/settings/legacy/acknowledge', 'POST', { accountId: account.accountId, counterVersion: state.counterVersion, confirmed: true });
    }, 'Reconocimiento de seguridad guardado.');
  }
  return <div className="conn-page">
    <PageActions><button className="button primary" aria-label="Nueva conexión" onClick={() => focusById('conn-name')}><Plus size={15} aria-hidden="true" /> <span className="btn-label">Nueva conexión</span></button></PageActions>
    <section aria-labelledby="conn-title">
      <div className="section-h"><h3 id="conn-title">Conexiones Meta</h3><p className="muted">Los tokens se cifran en el servidor y nunca se vuelven a mostrar.</p></div>
      {!connections.length ? <Empty nani="sleep" title="Todavía no tengo conexiones. Pásame un token de Meta y empiezo." detail="Guarde un token de Meta con el formulario «Nueva conexión»; después valídelo para descubrir sus cuentas." action={() => focusById('conn-name')} actionLabel="Crear la primera conexión" primary /> : <div className="tile-grid stagger">{connections.map((connection) => <article className="tile conn-tile" key={connection.id}>
        <div className="tile-head"><span className="ic accent"><PlugZap size={17} aria-hidden="true" /></span><div className="tile-title"><strong>{connection.name}</strong><span className="muted">{connection.login_kind === 'instagram_login' ? 'Instagram Login' : 'Facebook Login'} · <span className="mono">{connection.graph_version}</span></span></div><ConnectionBadge status={connection.status} /></div>
        <div className="tile-actions"><button className="btn-main small" onClick={() => void discover(connection.id)}><Search size={14} aria-hidden="true" /> Probar y descubrir</button>
          <span className="tile-actions-icons">
            <button className="btn-icon" aria-label="Editar" title="Editar" onClick={() => { setEditing(connection); setEditName(connection.name); setEditAppId(connection.app_id ?? ''); setEditVersion(connection.graph_version); setEditToken(''); }}><Pencil size={15}/></button>
            <button className="btn-icon danger" aria-label="Desconectar" title="Desconectar" onClick={() => void disconnect(connection)}><Unplug size={15}/></button>
            <button className="btn-icon danger" aria-label="Eliminar" title="Eliminar" onClick={() => void remove(connection)}><Trash2 size={15}/></button>
          </span></div>
      </article>)}</div>}
    </section>
    <div className="conn-columns">
      <div className="conn-forms">
        {editing && <form className="panel form-panel" onSubmit={(event) => void update(event)}><div className="panel-heading"><div><h3>Editar conexión</h3><p className="muted">Deje el token vacío para conservarlo. Si cambia, se invalida la validación anterior.</p></div></div><div className="form-grid"><Field label="Nombre"><input required value={editName} onChange={(event) => setEditName(event.target.value)} /></Field><Field label="App ID"><input value={editAppId} onChange={(event) => setEditAppId(event.target.value)} /></Field><Field label="Versión Graph"><input required pattern="v[0-9]+\.[0-9]+" value={editVersion} onChange={(event) => setEditVersion(event.target.value)} /></Field><Field label="Nuevo token · captura opcional"><input type="password" autoComplete="new-password" value={editToken} onChange={(event) => setEditToken(event.target.value)} /></Field></div><div className="row-actions"><button className="btn-main">Guardar cambios</button><button type="button" className="btn" onClick={() => { setEditToken(''); setEditing(null); }}>Cancelar</button></div></form>}
        <form className="panel form-panel" onSubmit={(event) => void create(event)}><div className="panel-heading"><div><h3>Nueva conexión</h3><p className="muted">Use un token con acceso autorizado a la cuenta que desea administrar.</p></div></div>
          <div className="form-grid"><Field label="Nombre"><input id="conn-name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Cuenta principal" /></Field><Field label="Tipo de acceso"><select value={loginKind} onChange={(event) => setLoginKind(event.target.value)}><option value="instagram_login">Instagram Login · token de Instagram</option><option value="facebook_login">Facebook Login · token de usuario y página vinculada</option></select></Field><Field label="App ID (opcional)"><input value={appId} onChange={(event) => setAppId(event.target.value)} /></Field><Field label="Versión Graph"><input required pattern="v[0-9]+\.[0-9]+" value={version} onChange={(event) => setVersion(event.target.value)} /></Field><Field label="Token de acceso · solo captura"><input required type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} /></Field></div>
          <div><button className="btn-main" type="submit"><Lock size={15} aria-hidden="true" /> Guardar conexión cifrada</button></div>
        </form>
      </div>
      <aside className="conn-side">
        <section className="panel"><div className="panel-heading"><div><h3>Cuentas seleccionadas</h3><p className="muted">Los ID se obtienen de la respuesta oficial de Meta.</p></div></div>{accounts.length ? <div className="avatar-tiles">{accounts.map((account) => <div className="list-row avatar-tile" key={account.accountId}><RingAvatar username={account.username} /><div className="list-row-text"><strong>@{account.username}</strong><span className="muted">{account.status === 'valid' ? 'Validada' : account.status} · {account.accountId}</span></div></div>)}</div> : <p className="empty-inline">Aún no hay cuentas seleccionadas. Pruebe una conexión y pulse «Seleccionar» en la cuenta que desea usar.</p>}</section>
        <section className="panel"><h3>Cuentas descubiertas</h3>{candidates.length ? <div className="avatar-tiles">{candidates.map((candidate) => <div className="list-row avatar-tile" key={candidate.providerAccountId}><RingAvatar username={candidate.username}/><div className="list-row-text"><strong>@{candidate.username}</strong><span className="muted">ID de proveedor: {candidate.providerAccountId}</span></div><button className="btn-main small" onClick={() => void act(() => api(`/api/connections/${candidate.connectionId}/select`, 'POST', { account: candidate }), 'Cuenta vinculada con su historial.')}>Seleccionar</button></div>)}</div> : <p className="empty-inline">Pulse «Probar y descubrir» en una conexión para listar las cuentas disponibles.</p>}</section>
        {legacyAccounts.length > 0 && <section className="panel"><h3>Retención heredada</h3><p className="muted">{features.legacyInterlock ? 'Una cuenta usada antes con otra herramienta puede tener un bloqueo o historial de rechazos previos. La aplicación nunca borra ni modifica esos archivos.' : 'Esta cuenta conserva una retención de una configuración heredada anterior. Revísela y reconózcala para liberarla.'}</p><div className="avatar-tiles">{legacyAccounts.map((account) => <div className="list-row avatar-tile" key={`legacy-${account.accountId}`}><RingAvatar username={account.username} /><div className="list-row-text"><strong>@{account.username}</strong></div><button className="btn small" onClick={() => void acknowledgeLegacy(account)}>Revisar estado y reconocer</button></div>)}</div></section>}
      </aside>
    </div>
  </div>;
}

function MediaView({ accounts, allAccounts, onSelectAccount, media, selected, onNavigate, api, act }: { accounts: Account[]; allAccounts: Account[]; onSelectAccount(id: string): void; media: Media[]; selected: string; onNavigate(id: string): void; api: Api; act: Act }) {
  const current = selected === 'all' ? '' : selected;
  const own = media.filter((item) => item.accountId === current);
  const choices = allAccounts.length ? allAccounts : accounts;
  const reload = () => void act(() => api(`/api/connections/${choices.find((item) => item.accountId === current)?.connectionId}/media`, 'POST', { accountId: current }), 'Publicaciones actualizadas.');
  return <section aria-labelledby="media-title">
    {current && <PageActions><button className="btn" aria-label="Actualizar publicaciones" onClick={reload}><RefreshCw size={15} aria-hidden="true" /> <span className="btn-label">Actualizar publicaciones</span></button></PageActions>}
    <div className="section-h"><h3 id="media-title">Publicaciones de la cuenta</h3><p className="muted">{current && own.length ? `${own.length} ${own.length === 1 ? 'publicación' : 'publicaciones'} guardadas en este equipo.` : 'Elija una cuenta para cargar sus publicaciones autorizadas.'}</p></div>
    {current ? own.length ? <div className="media-grid stagger">{own.map((item) => { const caption = shortCaption(item.caption, 80); return <article className="media-card" key={item.mediaId}><MediaThumb item={item} />
<div className="media-card-body">
  <strong className={caption ? 'media-caption' : 'media-caption muted-text'}>{caption ?? `Sin texto · ${shortId(item.mediaId)}`}</strong>
  <div className="media-meta"><span className="mono">{item.publishedAt ? formatDate(item.publishedAt) : 'Sin fecha'}</span>{item.permalink && <a className="media-link" href={item.permalink} target="_blank" rel="noreferrer"><ExternalLink size={12} aria-hidden="true" /> Ver en Instagram</a>}</div>
</div></article>; })}</div>
      : <Empty nani="awake" title="Aún no veo tus publicaciones. Descárgalas y las vigilo." detail="Descargue las publicaciones de esta cuenta para poder crear automatizaciones." action={reload} actionLabel="Actualizar publicaciones" primary />
      : choices.length ? <AccountPrompt id="media-account-prompt" title="Elija una cuenta para ver sus publicaciones" detail="Las publicaciones se cargan de una cuenta a la vez." choices={choices} onSelect={onSelectAccount} />
        : <Empty title="Aún no hay cuentas" detail="Conecte Meta y elija una cuenta antes de ver sus publicaciones." action={() => onNavigate('connections')} actionLabel="Ir a Conexiones" primary />}</section>;
}

/** "Choose an account" prompt shared by the account-scoped screens. */
function AccountPrompt({ id, title, detail, choices, onSelect }: { id: string; title: string; detail: string; choices: Array<{ accountId: string; username: string }>; onSelect(id: string): void }) {
  return <div className="account-prompt" role="group" aria-labelledby={id}>
    <span className="empty-icon" aria-hidden="true"><Users size={20} /></span>
    <strong id={id}>{title}</strong><p className="muted">{detail}</p>
    <div className="account-prompt-chips">{choices.map((account) => <button key={account.accountId} className="account-chip" onClick={() => onSelect(account.accountId)}><RingAvatar username={account.username} /> @{account.username}</button>)}</div>
  </div>;
}

function AutomationView({ accounts, media, rows, selected, api, act, confirm }: { accounts: Account[]; media: Media[]; rows: Automation[]; selected: string; api: Api; act: Act; confirm: Confirm }) {
  const [accountId, setAccountId] = useState(selected === 'all' ? '' : selected); const [mediaId, setMediaId] = useState(''); const [name, setName] = useState(''); const [keywords, setKeywords] = useState(''); const [replyText, setReplyText] = useState('Hola {{username}}, aquí tienes la información sobre {{keyword}}.'); const [mode, setMode] = useState('contains');
  const [buttonTitle, setButtonTitle] = useState(''); const [buttonUrl, setButtonUrl] = useState(''); const [buttonTitle2, setButtonTitle2] = useState(''); const [buttonUrl2, setButtonUrl2] = useState('');
  const [publicEnabled, setPublicEnabled] = useState(false); const [publicVariants, setPublicVariants] = useState('');
  const [editing, setEditing] = useState<Automation | null>(null);
  useEffect(() => { if (selected !== 'all') { setAccountId(selected); setMediaId(''); } }, [selected]);
  const ownMedia = media.filter((item) => item.accountId === accountId);
  async function create(event: FormEvent) { event.preventDefault(); const buttons = [{ title: buttonTitle, url: buttonUrl }, { title: buttonTitle2, url: buttonUrl2 }].filter((button) => button.title.trim() || button.url.trim()); await act(() => api('/api/automations', 'POST', { accountId, ...automationTargetPayload(mediaId), name, keywords: keywords.split(',').map((item) => item.trim()).filter(Boolean), replyText, matchMode: mode, buttons, publicReplyEnabled: publicEnabled, publicReplyVariants: parseVariantLines(publicVariants) }), 'Automatización guardada en modo de prueba.'); }
  async function toggleReal(row: Automation) {
    if (!row.realEnabled && !(await confirm({ title: `Autorizar respuestas reales en «${row.name}»`, body: 'Esta automatización podrá enviar mensajes privados reales cuando el Dry Run global esté desactivado. El Dry Run global sigue siendo un control independiente.', confirmLabel: 'Autorizar modo real', danger: true }))) return;
    await act(() => api(`/api/automations/${row.automationId}/real`, 'PATCH', { accountId: row.accountId, enabled: !row.realEnabled, confirmed: true }), row.realEnabled ? 'Respuestas reales desactivadas.' : 'Automatización autorizada para modo real.');
  }
  async function archive(row: Automation) {
    if (!(await confirm({ title: `Archivar «${row.name}»`, body: 'Archivar detiene esta automatización y conserva el historial. No podrá reactivarla desde esta pantalla.', confirmLabel: 'Archivar', danger: true }))) return;
    await act(() => api(`/api/automations/${row.automationId}/delete`, 'POST', { accountId: row.accountId }), 'Automatización archivada.');
  }
  const previewUser = accounts.find((item) => item.accountId === accountId)?.username;
  return <div className="auto-page">
    <PageActions><button className="button primary" aria-label="Nueva automatización" onClick={() => focusById('auto-account')}><Plus size={15} aria-hidden="true" /> <span className="btn-label">Nueva automatización</span></button></PageActions>
    <section aria-labelledby="auto-list-title">
      <div className="section-h"><h3 id="auto-list-title">Tus automatizaciones</h3><p className="muted">Cada regla responde por mensaje privado cuando un comentario contiene sus palabras clave.</p></div>
      {rows.length ? <div className="recipe-grid stagger">{rows.map((row) => { const owner = accounts.find((item) => item.accountId === row.accountId)?.username; return <article className="automation-row tile" key={row.automationId}>
        <div className="recipe-flow">
          {row.scope === 'account' ? <span className="recipe-thumb ph"><Layers size={18} aria-hidden="true" /></span> : <MiniThumb size="recipe" item={media.find(m => m.mediaId === row.mediaId)} />}
          <ArrowRight size={16} className="recipe-arrow" aria-hidden="true" />
          <div className="recipe-body">
            <strong>{row.name}</strong>
            <span className="dm">{sampleReply(row.replyText, row.keywords[0]?.phrase) || 'Sin mensaje'}</span>
            <div className="keyword-list">{row.keywords.length ? row.keywords.map((keyword) => <span className="kw-chip" key={keyword.phrase}>{keyword.phrase}</span>) : <span className="muted">Sin palabras clave</span>}</div>
          </div>
        </div>
        <div className="recipe-scope muted"><RingAvatar username={owner} size="sm" /> <span className="recipe-scope-text">@{owner || 'Cuenta'} · {automationTargetLabel(row, media)}</span></div>
        <div className="chip-row">
          {row.scope === 'account' && <Status value="General" tone="neutral" />}
          <Status value={row.status === 'enabled' ? 'Activa' : 'Pausada'} tone={row.status === 'enabled' ? 'good' : 'neutral'} />
          <Status value={row.realEnabled ? 'Real autorizado' : 'Solo prueba'} tone={row.realEnabled ? 'warn' : 'neutral'} />
          {row.publicReplyEnabled && <Status value={`Respuesta pública · ${variantCountLabel(row.publicReplyVariants?.length ?? 0)}`} tone="neutral" />}
        </div>
        <div className="tile-actions">
          <button className={row.realEnabled ? 'btn small' : 'btn btn-danger small'} onClick={() => void toggleReal(row)}>{row.realEnabled ? <ShieldOff size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />} {row.realEnabled ? 'Quitar permiso real' : 'Autorizar real'}</button>
          <span className="tile-actions-icons">
            <button className="btn-icon" title={row.status === 'enabled' ? 'Pausar' : 'Activar'} aria-label={row.status === 'enabled' ? 'Pausar' : 'Activar'} onClick={() => void act(() => api(`/api/automations/${row.automationId}/enabled`, 'PATCH', { accountId: row.accountId, enabled: row.status !== 'enabled' }), row.status === 'enabled' ? 'Automatización pausada.' : 'Automatización activada con corte desde ahora.')}>{row.status === 'enabled' ? <Pause size={15} /> : <Play size={15} />}</button>
            <button className="btn-icon" title="Editar" aria-label="Editar" onClick={() => setEditing(row)}><Pencil size={15} /></button>
            <button className="btn-icon danger" title="Archivar" aria-label="Archivar" onClick={() => void archive(row)}><Archive size={15} /></button>
          </span>
        </div>
      </article>; })}</div> : <Empty nani="awake" title="Aún no sé qué responder. Enséñame con una automatización." detail="Cree una automatización asociada a una de sus publicaciones. Empieza en modo prueba." action={() => focusById('auto-account')} actionLabel="Crear la primera automatización" primary />}
    </section>
    {editing && <AutomationEditDialog row={editing} mediaOptions={media.filter((item) => item.accountId === editing.accountId).map((item) => ({ id: item.mediaId, label: mediaLabel(item) }))} onClose={() => setEditing(null)} onSave={async (values) => {
      const saved = await act(() => api(`/api/automations/${editing.automationId}`, 'PUT', { accountId: editing.accountId, mediaId: editing.scope === 'account' ? null : values.mediaId, name: values.name, replyText: values.replyText, matchMode: values.matchMode, buttons: editing.buttons ?? [], keywords: values.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean), publicReplyEnabled: values.publicReplyEnabled, publicReplyVariants: parseVariantLines(values.publicReplyVariants) }), 'Automatización actualizada; se invalidaron elementos con plantilla anterior.');
      if (saved) setEditing(null);
    }} />}
    <div className="composer">
      <form className="panel form-panel composer-form" onSubmit={(event) => void create(event)}><div className="panel-heading"><div><h3>Nueva automatización</h3><p className="muted">Seleccione primero la cuenta; las publicaciones pertenecen a esa cuenta.</p></div></div>
        <div className="seq-header"><span className="seq-num">1</span> Dónde responder</div><div className="form-grid"><Field label="Cuenta"><select id="auto-account" required value={accountId} onChange={(event) => { setAccountId(event.target.value); setMediaId(''); }}><option value="">Seleccione una cuenta</option>{accounts.map((account) => <option key={account.accountId} value={account.accountId}>@{account.username}</option>)}</select></Field><Field label="Publicación"><select required disabled={!accountId} value={mediaId} onChange={(event) => setMediaId(event.target.value)}><option value="">Seleccione una publicación</option><option value={GENERAL_MEDIA_OPTION}>Todas las publicaciones (general)</option>{ownMedia.map((item) => <option key={item.mediaId} value={item.mediaId}>{mediaLabel(item)}</option>)}</select>{mediaId === GENERAL_MEDIA_OPTION && <small className="hint">Se aplica a cualquier publicación de la cuenta que no tenga su propia automatización; solo comentarios posteriores a la activación.</small>}</Field><Field label="Nombre"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field></div>
        <div className="seq-header"><span className="seq-num">2</span> Cuándo</div><div className="form-grid"><Field label="Palabras clave · separadas por coma"><input required value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="guia, ebook" /></Field><Field label="Coincidencia"><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="contains">Frase dentro del comentario</option><option value="exact">Comentario exacto</option></select></Field></div>
        <div className="seq-header"><span className="seq-num">3</span> Qué responde</div><div className="form-grid full-width"><Field label="Respuesta · variables {{username}}, {{comment}}, {{keyword}}"><textarea required rows={4} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></Field></div>
        <div className="seq-header"><span className="seq-num">4</span> Botones (opcional)</div><div className="form-grid"><Field label="Botón URL opcional · título"><input maxLength={20} value={buttonTitle} onChange={(event) => setButtonTitle(event.target.value)} placeholder="Ver recurso" /></Field><Field label="URL HTTPS"><input type="url" value={buttonUrl} onChange={(event) => setButtonUrl(event.target.value)} placeholder="https://…" /></Field><Field label="Segundo botón · título opcional"><input maxLength={20} value={buttonTitle2} onChange={(event) => setButtonTitle2(event.target.value)} /></Field><Field label="Segundo botón · URL HTTPS"><input type="url" value={buttonUrl2} onChange={(event) => setButtonUrl2(event.target.value)} /></Field></div><p className="hint">{MEDIA_LINK_TIP}</p>
        <div className="seq-header"><span className="seq-num">5</span> Respuesta pública (opcional)</div><PublicReplyFields idPrefix="new" enabled={publicEnabled} setEnabled={setPublicEnabled} text={publicVariants} setText={setPublicVariants} /><p className="hint">Puede añadir cero, uno o dos botones URL en esta pantalla. Las palabras clave son sinónimos: si varias aparecen en un mismo comentario, se procesa una sola coincidencia.</p>
        <div><button className="btn-main" disabled={!accountId || !mediaId}>Guardar automatización</button></div></form>
      <aside className="composer-preview" aria-label="Vista previa del mensaje privado">
        <div className="phone">
          <div className="screen">
            <div className="chat-top">
              <RingAvatar username={previewUser} />
              <div>
                <b>Vista previa</b>
                <small>@{previewUser ?? 'cuenta'}</small>
              </div>
            </div>
            <div className="chat">
              <div className="context">Simulación de respuesta privada</div>
              {replyText ? (
                <div className="bubble">
                  {replyText.replace(/{{username}}/g, 'ana').replace(/{{keyword}}/g, keywords.split(',')[0]?.trim() || 'palabra')}
                  {buttonTitle.trim() && buttonUrl.trim() && <div className="pbtn">{buttonTitle}</div>}
                  {buttonTitle2.trim() && buttonUrl2.trim() && <div className="pbtn">{buttonTitle2}</div>}
                </div>
              ) : (
                <div className="bubble empty">Escriba un mensaje para ver la vista previa.</div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>;
}

function AutomationEditDialog({ row, mediaOptions, onSave, onClose }: { row: Automation; mediaOptions: Array<{ id: string; label: string }>; onSave(values: { name: string; mediaId: string; keywords: string; replyText: string; matchMode: 'exact' | 'contains'; publicReplyEnabled: boolean; publicReplyVariants: string }): Promise<void>; onClose(): void }) {
  const [name, setName] = useState(row.name); const [mediaId, setMediaId] = useState(row.mediaId ?? ''); const isGeneral = row.scope === 'account';
  const [keywords, setKeywords] = useState(row.keywords.map((item) => item.phrase).join(', '));
  const [replyText, setReplyText] = useState(row.replyText ?? 'Hola {{username}}'); const [matchMode, setMatchMode] = useState<string>(row.matchMode ?? 'contains');
  const [publicEnabled, setPublicEnabled] = useState(Boolean(row.publicReplyEnabled)); const [publicVariants, setPublicVariants] = useState((row.publicReplyVariants ?? []).join('\n'));
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (matchMode !== 'exact' && matchMode !== 'contains') { setProblem('Modo inválido: elija coincidencia exacta o frase dentro del comentario.'); return; }
    if (publicEnabled && parseVariantLines(publicVariants).length === 0) { setProblem('Añada al menos una variante para la respuesta pública o desactívela.'); return; }
    setProblem(''); setBusy(true);
    try { await onSave({ name: name.trim(), mediaId: mediaId.trim(), keywords, replyText, matchMode, publicReplyEnabled: publicEnabled, publicReplyVariants: publicVariants }); } finally { setBusy(false); }
  }
  return <Modal titleId="edit-auto-title" descriptionId="edit-auto-desc" onClose={onClose} wide>
    <form onSubmit={(event) => void submit(event)} className="modal-form">
      <h2 id="edit-auto-title">Editar automatización</h2>
      <p id="edit-auto-desc" className="muted">Los cambios invalidan los elementos en cola creados con la plantilla anterior. Los botones URL existentes se conservan.</p>
      <div className="form-grid">
        <Field label="Nombre"><input data-autofocus required value={name} onChange={(event) => setName(event.target.value)} /></Field>
        {isGeneral ? <p className="hint">Automatización general: se aplica a todas las publicaciones sin automatización propia. El alcance no se puede cambiar; para una sola publicación cree una nueva.</p>
          : <Field label="ID de publicación de esta cuenta"><input required list="edit-media-options" value={mediaId} onChange={(event) => setMediaId(event.target.value)} /></Field>}
        </div><div className="form-grid"><Field label="Palabras clave sinónimas · separadas por coma"><input required value={keywords} onChange={(event) => setKeywords(event.target.value)} /></Field>
        <Field label="Coincidencia"><select value={matchMode} onChange={(event) => setMatchMode(event.target.value)}><option value="contains">Frase dentro del comentario (contains)</option><option value="exact">Comentario exacto (exact)</option></select></Field>
        <Field label="Plantilla de respuesta · variables {{username}}, {{comment}}, {{keyword}}"><textarea required rows={4} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></Field>
      </div>
      <PublicReplyFields idPrefix="edit" enabled={publicEnabled} setEnabled={setPublicEnabled} text={publicVariants} setText={setPublicVariants} />
      <datalist id="edit-media-options">{mediaOptions.map((option) => <option key={option.id} value={option.id} label={option.label} />)}</datalist>
      {problem && <p className="form-problem" role="alert">{problem}</p>}
      <div className="modal-actions"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="submit" className="btn-main" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </form>
  </Modal>;
}

/** Optional public reply: checkbox, one variant per line, live count, two random rendered examples and the ordering guarantee. */
function PublicReplyFields({ idPrefix, enabled, setEnabled, text, setText }: { idPrefix: string; enabled: boolean; setEnabled(value: boolean): void; text: string; setText(value: string): void }) {
  const variants = useMemo(() => parseVariantLines(text), [text]);
  const [seed, setSeed] = useState(0);
  // `seed` re-rolls the two random examples on "Otros ejemplos".
  const examples = useMemo(() => (seed >= 0 ? previewExamples(variants) : []), [variants, seed]);
  return <fieldset className="public-reply-fields">
    <label className="toggle-row" htmlFor={`${idPrefix}-public-enabled`}>
  <input id={`${idPrefix}-public-enabled`} type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
  <div className="toggle-row-text">
    <strong>Responder también públicamente al comentario</strong>
    <span>Enviará un comentario de respuesta visible en la publicación.</span>
  </div>
</label>
    {enabled && <>
      <Field label="Variantes de la respuesta pública (una por línea)"><textarea id={`${idPrefix}-public-variants`} required rows={5} value={text} onChange={(event) => setText(event.target.value)} placeholder={'¡Listo @{{username}}! Te escribí por mensaje privado\nRevisa tu bandeja de entrada, @{{username}}'} aria-describedby={`${idPrefix}-public-hint`} /></Field>
      <div className="row-between"><span className="count-badge" aria-live="polite">{variantCountLabel(variants.length)}</span>{examples.length > 0 && <button type="button" className="btn-link text-button" onClick={() => setSeed((value) => value + 1)}>Otros ejemplos</button>}</div>
      {examples.length > 0 && <div className="preview-box" aria-label="Ejemplos de respuesta pública"><small className="muted">Ejemplos con el usuario @{PUBLIC_REPLY_SAMPLE_USERNAME}:</small><ul>{examples.map((example) => <li key={example}>{example}</li>)}</ul></div>}
      <p className="hint" id={`${idPrefix}-public-hint`}>Se publica DESPUÉS del mensaje privado y solo si este fue aceptado. Si la respuesta pública falla, el mensaje privado nunca se repite. Cada vez se elige una variante distinta de las últimas usadas. Variables: {'{{username}}'} y {'{{keyword}}'}; máximo 50 variantes de 300 caracteres, sin enlaces ni otras menciones.</p>
    </>}
  </fieldset>;
}

type DiagnosticsResult = { igsid: string; conversation: { found: boolean; safeErrorCode?: string; messages: Array<{ id: string; createdTime?: string; direction: string; text?: string; keys: string[]; attachmentsShape: string; safeErrorCode?: string }> }; profile: { ok: boolean; isUserFollowBusiness?: boolean; isBusinessFollowUser?: boolean; safeErrorCode?: string; requestedFields?: string; hostKind?: string; metaError?: { httpStatus?: number; code?: number; subcode?: number; type?: string; message?: string; fbtraceId?: string } } };

/** EXPERIMENTAL read-only inspection of the conversation with the comment author; it never sends anything. */
function ConversationInspector({ item, api }: { item: QueueItem; api: Api }) {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<DiagnosticsResult | null>(null); const [problem, setProblem] = useState('');
  async function inspect() {
    setBusy(true); setProblem('');
    try { setResult(await api(`/api/diagnostics/conversation?${new URLSearchParams({ accountId: item.accountId, commentId: item.commentId })}`)); }
    catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      setProblem(code === 'igsid_unknown' ? 'Aún no se conoce el identificador del autor: vuelva a analizar o monitorear esta publicación y reintente.'
        : code === 'diagnostics_rate_limited' ? 'Espere 20 segundos antes de volver a inspeccionar.' : `No se pudo inspeccionar: ${/^[a-z0-9_]{1,64}$/u.test(code) ? code : 'diagnostics_unavailable'}`);
    } finally { setBusy(false); }
  }
  const yesNo = (value?: boolean) => value === undefined ? 'sin dato' : value ? 'sí' : 'no';
  return <div className="readback-check">
    <button className="btn" disabled={busy} onClick={() => void inspect()}>{busy ? 'Inspeccionando…' : 'Inspeccionar conversación (experimental)'}</button>
    <small className="hint">Solo LEE la conversación y el perfil en Meta (puede tardar ~10 s); no envía nada.</small>
    {problem && <span role="status">{problem}</span>}
    {result && <div className="preview-box" role="status">
      <p><strong>Autor:</strong> {result.igsid} · <strong>Conversación:</strong> {result.conversation.found ? 'encontrada' : 'no encontrada'}{result.conversation.safeErrorCode ? ` (${result.conversation.safeErrorCode})` : ''}</p>
      <p><strong>Perfil:</strong> {result.profile.ok ? `te sigue: ${yesNo(result.profile.isUserFollowBusiness)} · lo sigues: ${yesNo(result.profile.isBusinessFollowUser)}` : `no disponible (${result.profile.safeErrorCode ?? 'sin código'})`}</p>
      {result.profile.requestedFields && <p><small className="muted">Campos pedidos: {result.profile.requestedFields} · host: {result.profile.hostKind ?? '—'}</small></p>}
      {result.profile.metaError && <p><strong>Error de Meta:</strong> {`código ${result.profile.metaError.code ?? '—'} / subcódigo ${result.profile.metaError.subcode ?? '—'}${result.profile.metaError.httpStatus ? ` (HTTP ${result.profile.metaError.httpStatus})` : ''}${result.profile.metaError.type ? ` · ${result.profile.metaError.type}` : ''} — ${result.profile.metaError.message ?? 'sin mensaje'}${result.profile.metaError.fbtraceId ? ` · traza ${result.profile.metaError.fbtraceId}` : ''}`}</p>}
      {result.conversation.messages.length > 0 && <ol className="attempt-list">{result.conversation.messages.map((message) => <li key={message.id}><strong>{directionLabel(message.direction)}</strong> <span>{message.createdTime ? formatDate(message.createdTime) : '—'}</span> <span>{message.text ?? (message.safeErrorCode ? `Error: ${message.safeErrorCode}` : 'Sin texto')}</span> <small className="muted">Campos: {message.keys.join(', ') || '—'} · adjuntos: {message.attachmentsShape}</small></li>)}</ol>}
    </div>}
  </div>;
}

function MonitorView({ accounts, status, onNavigate, api, act }: { accounts: Account[]; status: boolean; onNavigate(id: string): void; api: Api; act: Act }) {
  return <section aria-labelledby="monitor-title">
    <PageActions><button className="btn-main" onClick={() => void monitorAll(api, act, 'start')}><Play size={15} aria-hidden="true" /> Iniciar todas</button><button className="btn" onClick={() => void monitorAll(api, act, 'stop')}><Pause size={15} aria-hidden="true" /> Detener todas</button></PageActions>
    <div className={status ? 'monitor-hero on' : 'monitor-hero'}>
      <Nani state={status ? 'awake' : 'sleep'} size={48} decorative />
      <div><h3 id="monitor-title">Monitoreo</h3><p className="muted">El monitoreo siempre inicia apagado al reiniciar la aplicación.</p></div>
      <Status value={status ? 'Activo' : 'Detenido'} tone={status ? 'good' : 'neutral'} />
    </div>
    {accounts.length ? <div className="tile-grid stagger">{accounts.map((account) => <article className={account.monitoringPaused ? 'tile monitor-tile' : 'tile monitor-tile live'} key={account.accountId}>
      <div className="tile-head"><RingAvatar username={account.username} /><div className="tile-title"><strong>@{account.username}</strong><span className="muted">{account.last_sync ? <>Última sincronización <span className="mono nowrap">{formatDate(account.last_sync)}</span></> : 'Sin sincronización'}</span></div></div>
      <div className="monitor-state"><Nani state={status && !account.monitoringPaused ? 'awake' : 'sleep'} size={56} /><span className="monitor-state-text">{account.monitoringPaused ? 'Pausado' : 'En monitoreo'}</span></div>
      <div className="tile-actions"><button className="btn small" onClick={() => void act(() => api(`/api/monitor/${account.accountId}`, 'POST', { action: account.monitoringPaused ? 'start' : 'stop' }), account.monitoringPaused ? 'Cuenta en monitoreo.' : 'Monitoreo pausado.')}>{account.monitoringPaused ? <><Play size={14}/> Reanudar</> : <><Pause size={14}/> Detener</>}</button></div>
    </article>)}</div> : <Empty nani="sleep" title="No tengo cuentas que vigilar todavía." detail="Valide y seleccione una cuenta antes de iniciar el monitoreo." action={() => onNavigate('connections')} actionLabel="Ir a Conexiones" primary />}
  </section>;
}

const WINDOW_LABELS: Record<string, string> = { '2h': 'Últimas 2 horas', '24h': 'Últimas 24 horas', '3d': 'Últimos 3 días', '7d': 'Últimos 7 días', custom: 'Desde una fecha…' };

const PENDING_PAGE = 50;

function BacklogView({ allAccounts, accounts, selected, onSelectAccount, job, setJob, rows, api, act, confirm }: { allAccounts: Account[]; accounts: Account[]; selected: string; onSelectAccount(id: string): void; job: ScanJob | null; setJob(value: ScanJob | null): void; rows: Automation[]; api: Api; act: Act; confirm: Confirm }) {
  const [windowValue, setWindow] = useState('24h'); const [customSince, setCustomSince] = useState(''); const [selectedIds, setSelectedIds] = useState<string[]>([]); const [automationId, setAutomationId] = useState('');
  const [pending, setPending] = useState<PendingPage | null>(null); const [pendingError, setPendingError] = useState(false); const [pendingOffset, setPendingOffset] = useState(0);
  // Pending review is always account-scoped: it follows the global filter (a single account is auto-selected upstream).
  const processAccount = selected === 'all' ? '' : selected;
  const choices = allAccounts.length ? allAccounts : accounts;
  const [cancelling, setCancelling] = useState(false); const [tick, setTick] = useState(() => Date.now());
  const running = job?.status === 'running';
  useEffect(() => { if (!running) { setCancelling(false); return; } setTick(Date.now()); const timer = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const summary = useMemo(() => summarizeScan(job?.result), [job]);
  const loadPending = useCallback(async () => {
    if (!processAccount) { setPending(null); return; }
    try { setPending(await api(`/api/backlog/pending?${new URLSearchParams({ accountId: processAccount, limit: String(PENDING_PAGE), offset: String(pendingOffset) })}`)); setPendingError(false); }
    catch { setPendingError(true); }
  }, [api, processAccount, pendingOffset]);
  // Reload on open, on account change, and whenever an analysis leaves the running state.
  useEffect(() => { setSelectedIds([]); setPendingOffset(0); }, [processAccount]);
  useEffect(() => { if (!running) void loadPending(); }, [loadPending, running, job?.id]);
  useEffect(() => { setAutomationId((current) => autoPickAutomation(rows, processAccount, current)); }, [rows, processAccount]);
  const items = pending?.items ?? [];
  const eligibleForChoice = (item: PendingItem) => !automationId || item.automationId === automationId;
  async function processSelection() {
    if (!(await confirm({ title: 'Añadir comentarios a la cola', body: `Se añadirán ${selectedIds.length} comentario(s) seleccionados a la cola de la automatización elegida. Si el modo real está activo y la automatización está autorizada, podrían enviarse respuestas privadas reales.`, confirmLabel: `Añadir ${selectedIds.length} a la cola`, danger: true }))) return;
    const ok = await act(() => api('/api/backlog/process', 'POST', { accountId: processAccount, automationId, commentIds: selectedIds, confirmed: true }), 'Selección explícita añadida a la cola.');
    if (ok) { setSelectedIds([]); await loadPending(); }
  }
  return <div className="backlog-page">
    <section className="panel analyze-panel" aria-labelledby="analyze-title">
      <div className="panel-heading"><div><h3 id="analyze-title">Analizar comentarios</h3><p className="muted">El análisis solo clasifica; no añade mensajes a la cola ni los envía.</p></div></div>
      <div className="analyze-bar"><div className="form-grid compact"><Field label="Ventana"><select value={windowValue} onChange={(event) => setWindow(event.target.value)}>{['2h', '24h', '3d', '7d', 'custom'].map((value) => <option key={value} value={value}>{WINDOW_LABELS[value]}</option>)}</select></Field>{windowValue === 'custom' && <Field label="Desde"><input type="datetime-local" value={customSince} onChange={(event) => setCustomSince(event.target.value)} /></Field>}</div><div className="row-actions"><button id="backlog-start" className="btn-main" disabled={!!job && job.status === 'running'} onClick={() => void act(async () => { const result = await api('/api/backlog/jobs', 'POST', { accountId: selected, window: windowValue, ...(customSince ? { customSince: new Date(customSince).toISOString() } : {}) }); setJob({ id: result.jobId, status: 'running', createdAt: new Date().toISOString() }); }, 'Análisis iniciado; puede continuar usando otras secciones.')}><ScanEye size={15} aria-hidden="true" /> Iniciar análisis</button>{job?.status === 'running' && <button className="btn" disabled={cancelling} onClick={() => { setCancelling(true); void api(`/api/backlog/jobs/${job.id}/cancel`, 'POST', {}).catch(() => setCancelling(false)); }}>{cancelling ? 'Cancelando…' : 'Cancelar'}</button>}</div></div>
      {!job && <p className="hint spaced">Sin análisis en esta sesión. Elija una ventana de tiempo e inicie el análisis para ver qué comentarios habrían coincidido.</p>}
      {job && <div className="job-status">Análisis: {job.status === 'running' ? <Status value="En curso" tone="neutral" /> : job.status === 'complete' ? <Status value="Finalizado" tone="good" /> : job.status === 'partial' ? <Status value="Cobertura parcial" tone="warn" /> : job.status === 'cancelled' ? <Status value="Cancelado" tone="neutral" /> : <Status value="Error" tone="danger" />} <span>{job.status === 'partial' ? 'Una o más cuentas tuvieron cobertura incompleta.' : 'El análisis no envía mensajes.'}</span></div>}
      {job && running && <ScanProgressPanel progress={job.progress} elapsedMs={tick - Date.parse(job.createdAt ?? '') || 0} />}
      {job && !running && <ScanSummaryCard status={job.status} summary={summary} />}
    </section>
    <section className="pending-review" aria-labelledby="pending-title">
      <div className="section-h row"><div><h3 id="pending-title">Comentarios pendientes de revisión</h3><p className="muted">Resultados del último análisis completo; se conservan al recargar. Ya en cola o con más de 7 días no aparecen.</p></div>{pending && <span className="count-badge">{pending.total} pendientes</span>}</div>
      {!processAccount ? (choices.length ? <AccountPrompt id="backlog-account-prompt" title="Elija una cuenta para ver sus comentarios pendientes" detail="La revisión se hace de una cuenta a la vez." choices={choices} onSelect={onSelectAccount} /> : <p className="hint">Aún no hay cuentas disponibles.</p>)
        : pendingError ? <p className="form-problem" role="alert">No se pudieron cargar los comentarios pendientes. <button className="btn-link text-button" onClick={() => void loadPending()}>Reintentar</button></p>
        : !pending ? <p className="hint">Cargando comentarios pendientes…</p>
        : <>
          <p className="muted status-line" role="status">{pending.lastAnalyzedAt ? `Última revisión: ${formatDate(pending.lastAnalyzedAt)}` : 'Esta cuenta aún no tiene un análisis completo.'} · {pending.total} {pending.total === 1 ? 'comentario pendiente' : 'comentarios pendientes'}</p>
          {items.length > 0 ? <>
            <div className="process-bar"><div className="form-grid compact"><Field label="Cuenta"><input readOnly value={`@${accounts.find((item) => item.accountId === processAccount)?.username ?? choices.find((item) => item.accountId === processAccount)?.username ?? ''}`} /></Field><Field label="Procesar con automatización"><select value={automationId} onChange={(event) => { setAutomationId(event.target.value); setSelectedIds([]); }}><option value="">Seleccione</option>{rows.filter((row) => row.status === 'enabled' && row.accountId === processAccount).map((row) => <option key={row.automationId} value={row.automationId}>{row.name}</option>)}</select></Field></div><div className="row-actions"><span className="muted selection-count">{selectedIds.length} {selectedIds.length === 1 ? 'seleccionado' : 'seleccionados'}</span><button className="btn" disabled={!automationId} onClick={() => setSelectedIds(items.filter((item) => item.automationId === automationId).map((item) => item.commentId))}>Seleccionar todos los visibles</button><button className="btn-main" disabled={!selectedIds.length || !automationId || !processAccount} onClick={() => void processSelection()}>Procesar selección revisada</button></div></div>
            <div className="table-wrap"><table className="dense-table"><thead><tr><th className="col-check"><span className="visually-hidden">Seleccionar</span></th><th>Usuario</th><th>Comentario</th><th>Fecha</th><th>Automatización · publicación</th><th>Palabra clave</th><th>Vista previa del mensaje</th></tr></thead><tbody>{items.map((item) => <tr key={`${item.commentId}-${item.automationId}`} className={selectedIds.includes(item.commentId) ? 'selected' : undefined}>
              <td className="col-check"><input type="checkbox" aria-label={`Seleccionar comentario de @${item.username || 'usuario'}: ${item.commentText.slice(0, 40)}`} disabled={!eligibleForChoice(item)} checked={selectedIds.includes(item.commentId)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, item.commentId] : selectedIds.filter((id) => id !== item.commentId))} /></td>
              <td><div className="cell-user"><RingAvatar username={item.username} size="sm" /> {item.username ? `@${item.username}` : '—'}</div></td><td className="comment-cell" title={item.commentText}>{item.commentText || '—'}</td><td className="mono nowrap">{item.commentCreatedAt ? formatDate(item.commentCreatedAt) : '—'}</td><td>{item.automationName}{item.scope === 'account' && <> <Status value="General" tone="neutral" /></>}<small className="muted cell-sub">{mediaLabel({ mediaId: item.mediaId, caption: item.mediaCaption, mediaType: item.mediaType, publishedAt: item.mediaPublishedAt })}</small></td><td>{item.matchedKeywords.length ? item.matchedKeywords.map((keyword, index) => <span className="kw-chip" key={`${keyword}-${index}`}>{keyword}</span>) : '—'}</td>
              <td>{item.previewText ? <details className="message-preview"><summary>Ver mensaje</summary><div className="preview-box"><p>{item.previewText}</p>{item.previewButtons.length > 0 && <ul>{item.previewButtons.map((button) => <li key={button.url}>Botón «{button.title}» → {button.url}</li>)}</ul>}<small className="muted">Vista previa; nada se envía hasta procesar.</small></div></details> : <span className="muted">Sin vista previa</span>}</td>
            </tr>)}</tbody></table></div>
            {pending.total > PENDING_PAGE && <div className="pagination"><button className="btn" disabled={pendingOffset <= 0} onClick={() => setPendingOffset(Math.max(0, pendingOffset - PENDING_PAGE))}>Anterior</button><span>{pendingOffset + 1}–{pendingOffset + items.length} de {pending.total}</span><button className="btn" disabled={pendingOffset + items.length >= pending.total} onClick={() => setPendingOffset(pendingOffset + PENDING_PAGE)}>Siguiente</button></div>}
          </> : <Empty nani="awake" title="No encontré comentarios pendientes." detail="Analice los comentarios de esta cuenta para encontrar los que coinciden con una automatización." action={() => focusById('backlog-start')} actionLabel="Analizar comentarios" primary />}
        </>}
    </section>
  </div>;
}

function ScanProgressPanel({ progress, elapsedMs }: { progress?: ScanProgressDto; elapsedMs: number }) {
  const value = progress ?? { mediaDone: 0, mediaTotal: 0, pagesRead: 0, commentsSeen: 0 };
  const determinate = value.mediaTotal > 0;
  return <div className="scan-progress">
    <div className="progress-track" role="progressbar" aria-label="Progreso del análisis" aria-valuemin={0} aria-valuemax={determinate ? value.mediaTotal : 100} aria-valuenow={determinate ? value.mediaDone : undefined} aria-valuetext={progressText(value)}><div className="progress-fill" style={{ width: `${progressPercent(value)}%` }} /></div>
    <p className="progress-text"><strong>{progressText(value)}</strong><span className="muted"> · {formatElapsed(elapsedMs)} transcurridos</span></p>
    <p className="hint">Puede tardar varios minutos; no se envía nada.</p>
  </div>;
}

function ScanSummaryCard({ status, summary }: { status: string; summary: ReturnType<typeof summarizeScan> }) {
  const finished = status === 'complete' || status === 'partial' || status === 'cancelled';
  if (!finished) return null;
  const incomplete = summary.incompleteReports > 0 || summary.failedAccounts > 0 || status === 'partial';
  const headline = status === 'cancelled' ? 'Análisis cancelado' : incomplete ? 'Análisis terminado con cobertura incompleta' : 'Análisis finalizado';
  return <section className="panel scan-summary" aria-labelledby="scan-summary-title">
    <h4 id="scan-summary-title">{headline}</h4>
    <p role="status" aria-live="polite" className="visually-hidden">{headline}: {summary.commentsRead} comentarios leídos, {summary.eligible} coincidencias elegibles.</p>
    <dl className="summary-grid">
      <div><dt>Comentarios leídos</dt><dd>{summary.commentsRead}</dd></div>
      <div><dt>Coincidencias elegibles</dt><dd>{summary.eligible}</dd></div>
      <div><dt>Expirados (más de 7 días)</dt><dd>{summary.expired}</dd></div>
      <div><dt>En revisión</dt><dd>{summary.review}</dd></div>
      <div><dt>Respuestas (hilos)</dt><dd>{summary.replies}</dd></div>
      <div><dt>{reasonLabel('owner_replied')} (incluidos en revisión)</dt><dd>{summary.ownerReplied}</dd></div>
      <div><dt>Con errores o cobertura incompleta</dt><dd>{summary.incompleteReports + summary.failedAccounts}</dd></div>
    </dl>
    {incomplete && <p className="hint">Meta no devolvió todas las páginas o una cuenta falló: este resultado no cubre todos los comentarios. Puede repetir el análisis.</p>}
    <p className="hint">Analizar no envía nada. Elija comentarios elegibles abajo para añadirlos a la cola.</p>
  </section>;
}

function QueueView({ items, total, offset, setOffset, state, setState, onNavigate, api, act }: {
  items: QueueItem[];
  total: number;
  offset: number;
  setOffset(value: number): void;
  state: string;
  setState(value: string): void;
  onNavigate(id: string): void;
  api: Api;
  act: Act;
}) {
  const [expanded, setExpanded] = useState<string>('');
  const [publicEvents, setPublicEvents] = useState<Array<{ type: string; at: string; replyId?: string; safeErrorCode?: string }>>([]);
  const [events, setEvents] = useState<Array<{ type: string; at: string; messageId?: string; safeErrorCode?: string; details: Record<string, unknown> }>>([]);
  const [gateEvents, setGateEvents] = useState<Array<{ type: string; at: string; safeErrorCode?: string | null }>>([]);
  const [detailError, setDetailError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ itemId: string; text: string } | null>(null);
  async function loadAttempts(item: QueueItem) {
    const response = await api(`/api/queue/${item.id}/attempts?accountId=${encodeURIComponent(item.accountId)}`);
    setEvents(response.events);
    setPublicEvents(response.publicEvents ?? []);
    setGateEvents(response.gateEvents ?? []);
  }
  async function retryPublic(item: QueueItem) {
    // Explicit user action: only the public step of a FAILED (provably unpublished) reply; the private message is never re-sent.
    const ok = await act(() => api(`/api/queue/${item.id}/public-reply/retry`, 'POST', { accountId: item.accountId }), 'Respuesta pública reprogramada; el mensaje privado no se repite.');
    if (ok) await loadAttempts(item).catch(() => undefined);
  }
  async function showAttempts(item: QueueItem) {
    if (expanded === item.id) { setExpanded(''); return; }
    try {
      await loadAttempts(item);
      setDetailError(false);
      setVerifyResult(null);
      setExpanded(item.id);
    } catch {
      setDetailError(true);
    }
  }
  async function verifyReadback(item: QueueItem) {
    setVerifying(true);
    try {
      const result = await api(`/api/queue/${item.id}/readback`, 'POST', { accountId: item.accountId });
      setVerifyResult({ itemId: item.id, text: result.observed
        ? (result.matches ? 'Lectura confirmada: el mensaje y los botones coinciden' : 'Lectura confirmada, pero el contenido leído no coincide con lo enviado')
        : `No se pudo leer: ${result.safeErrorCode ?? 'readback_unavailable'}${readbackHint(result.safeErrorCode)}` });
      await loadAttempts(item);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setVerifyResult({ itemId: item.id, text: code === 'readback_rate_limited' ? 'Espere 30 segundos antes de volver a verificar.' : `No se pudo leer: ${/^[a-z0-9_]{1,64}$/u.test(code) ? code : 'readback_unavailable'}` });
    } finally {
      setVerifying(false);
    }
  }
  return <section className="queue-page" aria-labelledby="queue-title">
    <div className="section-h row">
      <div><h3 id="queue-title">Cola e historial</h3><p className="muted">Los resultados ambiguos nunca son reintentables automáticamente.</p></div>
      <div className="queue-tools">
        <label className="queue-filter"><ListFilter size={15} aria-hidden="true" /><span className="visually-hidden">Filtrar por estado</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">Todos los estados</option>
            {['SIMULATED', 'QUEUED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'UNKNOWN_OUTCOME', 'SENT', 'EXPIRED', 'SKIPPED'].map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}
          </select>
        </label>
        <span className="count-badge">{total} registros</span>
      </div>
    </div>
    {detailError && <p className="form-problem" role="alert">No se pudieron cargar los detalles del intento.</p>}
    {items.length ? <>
      <div className="table-wrap"><table className="dense-table queue-table">
        <thead><tr><th>Cuenta</th><th>Autor</th><th>Comentario</th><th>Estado</th><th>Intentos</th><th>ID de mensaje</th><th>Código seguro</th><th>Fecha</th><th>Historial</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} className={expanded === item.id ? 'expanded' : undefined}>
          <td><div className="cell-user"><RingAvatar username={item.username} size="sm" /> @{item.username}</div></td>
<td><div className="cell-user"><RingAvatar username={item.commentUsername} size="sm" /> {item.commentUsername ? `@${item.commentUsername}` : '—'}</div></td>
<td className="comment-cell" title={item.commentText || item.commentId}>{item.commentText || item.commentId}</td><td><Status value={stateLabel(item.state)} tone={queueTone(item.state)} />{item.state === 'UNKNOWN_OUTCOME' && <small className="state-hint">Revise manualmente en Instagram; nunca se reintenta.</small>}</td>
          <td className="mono">{item.attemptCount}</td><td className="mono id-cell">{item.messageId ?? '—'}</td><td className="mono id-cell">{item.safeErrorCode ?? '—'}</td>
          <td className="mono nowrap">{formatDate(item.createdAt)}</td><td><button className="btn-link text-button" onClick={() => void showAttempts(item)}>{expanded === item.id ? 'Ocultar' : 'Ver'}</button></td>
        </tr>).flatMap((row, index) => {
          const item = items[index]!;
          return expanded === item.id ? [row, <tr key={`${item.id}-events`} className="detail-row"><td colSpan={9}><div className="queue-detail">{(() => { const message = describeQueuePayload(item); return <div className="queue-message"><strong>{message.label}</strong>{message.text ? <p className="preview-box">{message.text}</p> : <p className="muted">Sin texto de mensaje guardado.</p>}{message.buttons.length > 0 && <ul>{message.buttons.map((button) => <li key={button.url}>Botón «{button.title}» → {button.url}</li>)}</ul>}</div>; })()}<FollowGateDetail item={item} events={gateEvents} />{(() => { const reply = describePublicReply(item); if (!reply) return null; return <div className="queue-message public-reply-detail"><strong>{reply.label}</strong>{reply.text ? <p className="preview-box">{reply.text}</p> : <p className="muted">Sin texto guardado.</p>}{reply.hint && <small className="state-hint">{reply.hint}</small>}{item.publicReply?.safeErrorCode && !publicReplyErrorHint(item.publicReply.safeErrorCode) && <small className="muted">Código: {item.publicReply.safeErrorCode}</small>}{reply.canRetry && <div><button className="btn small" onClick={() => void retryPublic(item)}>Reintentar respuesta pública</button></div>}{publicEvents.length > 0 && <div className="attempt-list">{publicEvents.map((event, eventIndex) => <div key={`public-${event.at}-${eventIndex}`}><strong>público · {event.type}</strong><span>{formatDate(event.at)}</span><span>{event.replyId ?? event.safeErrorCode ?? 'Sin detalle adicional'}</span></div>)}</div>}</div>; })()}{item.state === 'SENT' && <div className="readback-check">
            <button className="btn" disabled={verifying} onClick={() => void verifyReadback(item)}>{verifying ? 'Verificando…' : 'Verificar lectura'}</button>
            {verifyResult?.itemId === item.id && <span role="status">{verifyResult.text}</span>}
          </div>}{item.state === 'SENT' && <ConversationInspector key={`inspect-${item.id}`} item={item} api={api} />}<div className="attempt-list">
            {events.length ? events.map((event, eventIndex) => <div key={`${event.at}-${eventIndex}`}><strong>{event.type}</strong><span>{formatDate(event.at)}</span><span>{event.type === 'readback' ? readbackSummary(event) : (event.messageId ?? event.safeErrorCode ?? 'Sin detalle adicional')}</span></div>) : <span>{item.state === 'SIMULATED' ? 'Sin intentos: simulado, nada se envió.' : 'Sin intentos registrados.'}</span>}
          </div></div></td></tr>] : [row];
        })}</tbody>
      </table></div>
      <div className="pagination"><button className="btn" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Anterior</button><span>{offset + 1}–{Math.min(offset + items.length, total)} de {total}</span><button className="btn" disabled={offset + items.length >= total} onClick={() => setOffset(offset + 50)}>Siguiente</button></div>
    </> : <Empty nani="awake" title={state === 'all' ? 'Todavía no he respondido a nadie.' : 'No hay registros con este estado'} detail={state === 'all' ? 'Los comentarios nuevos y los seleccionados manualmente aparecerán aquí.' : 'Pruebe con otro estado o con «Todos los estados».'} action={state === 'all' ? () => onNavigate('backlog') : () => setState('all')} actionLabel={state === 'all' ? 'Revisar comentarios pendientes' : 'Ver todos los estados'} primary />}
  </section>;
}

/**
 * «Seguimiento» block of a queue item: only for a HISTORICAL follow gate session (the feature is retired). Past test
 * sessions stay readable; nothing new is ever created.
 */
function FollowGateDetail({ item, events }: { item: QueueItem; events: Array<{ type: string; at: string; safeErrorCode?: string | null }> }) {
  if (!showFollowGateDetail(item)) return null;
  const session = item.followGate!;
  const snapshot = item.payload?.followGate;
  const hint = followGateErrorHint(session.lastErrorCode) ?? attachmentErrorHint(session.lastErrorCode);
  const attachment = session.attachment ?? snapshot?.attachment;
  return <div className="queue-message follow-gate-detail">
    <strong>Seguimiento (función retirada · historial)</strong>
    {snapshot && <div className="preview-box"><small className="muted">Mensaje 1 · con botón:</small><p>{item.payload?.text ?? ''}</p><p><strong>[ {snapshot.buttonTitle} ]</strong></p><small className="muted">→ Al tocar el botón se intentaba enviar:</small>{attachment && <p>{attachmentPreviewLine(attachment.kind, attachment.url)}</p>}<p>{snapshot.resource.text}</p>{snapshot.resource.buttons.length > 0 && <ul>{snapshot.resource.buttons.map((button) => <li key={`${button.title}-${button.url}`}>Botón «{button.title}» → {button.url}</li>)}</ul>}</div>}
    <dl className="summary-grid">
      <div><dt>Estado</dt><dd><Status value={followGateStateLabel(session.state, session.tapAt)} tone={session.state === 'COMPLETED' ? 'good' : session.state === 'FAILED' ? 'danger' : session.state === 'UNKNOWN_OUTCOME' ? 'warn' : 'neutral'} /></dd></div>
      <div><dt>Botón enviado</dt><dd>{session.gateSentAt ? formatDate(session.gateSentAt) : '—'}</dd></div>
      <div><dt>Toque</dt><dd>{session.tapAt ? formatDate(session.tapAt) : 'Aún no'}</dd></div>
      <div><dt>Revisiones</dt><dd>{session.pollCount}</dd></div>
      {session.parts && <div><dt>Adjunto</dt><dd>{attachmentPartStateLabel(session.parts.attachment.state)}{session.parts.attachment.safeErrorCode ? ` · ${session.parts.attachment.safeErrorCode}` : ''}</dd></div>}
      {session.parts && <div><dt>Texto</dt><dd>{attachmentPartStateLabel(session.parts.text.state)}{session.parts.text.safeErrorCode ? ` · ${session.parts.text.safeErrorCode}` : ''}</dd></div>}
    </dl>
    {session.state === 'UNKNOWN_OUTCOME' && <small className="state-hint">Revise en Instagram si el recurso llegó; nunca se reintenta.</small>}
    {hint && <small className="state-hint">{hint}</small>}
    {session.lastErrorCode && <small className="muted">Código: {session.lastErrorCode}</small>}
    {events.length > 0 && <div className="attempt-list">{events.map((event, index) => <div key={`gate-${event.at}-${index}`}><strong>{followGateEventLabel(event.type)}</strong><span>{formatDate(event.at)}</span><span>{event.safeErrorCode ?? '—'}</span></div>)}</div>}
    <small className="hint">«Pedir primero que me sigan» está retirada: Meta no permite entregar el recurso después del toque del botón con esta aplicación. Ya no se crean seguimientos nuevos.</small>
  </div>;
}

function SettingsView({ mode, api, act, confirm, features }: { mode: 'checking' | 'dry' | 'real'; api: Api; act: Act; confirm: Confirm; features: Features }) {
  async function importEnv() {
    if (!(await confirm({ title: 'Importar .env del proyecto', body: 'Se leerá una vez el archivo .env configurado en SOCIAL_DESK_IMPORT_ENV_PATH y se importarán únicamente credenciales Meta permitidas, cifradas como una conexión nueva. El archivo no se modifica y el secreto no se muestra.', confirmLabel: 'Importar credenciales' }))) return;
    await act(() => api('/api/settings/import-root-env', 'POST', { confirmed: true }), 'Conexión importada de forma cifrada. Valídela y seleccione la cuenta.');
  }
  return <section className="settings-page" aria-labelledby="settings-title">
    <div className="section-h"><h3 id="settings-title">Seguridad y configuración</h3><p className="muted">La aplicación se ejecuta solo en este equipo; el monitoreo no se reactiva al reiniciar.</p></div>
    <div className="settings-list">
      <div className="settings-row"><span className={mode === 'real' ? 'ic bad' : 'ic warn'} aria-hidden="true">{mode === 'real' ? <Siren size={17} /> : <FlaskConical size={17} />}</span><div><strong>Modo de envío</strong><span className="muted">{mode === 'checking' ? 'Verificando el modo de envío…' : mode === 'dry' ? 'Dry Run activo: no se envían respuestas.' : 'Modo real activo; requiere automatizaciones autorizadas.'}</span></div>{mode === 'checking' ? <Status value="Verificando…" tone="neutral" /> : mode === 'dry' ? <Status value="Dry Run" tone="good" /> : <Status value="Modo real" tone="warn" />}</div>
      <div className="settings-row"><span className="ic accent" aria-hidden="true"><FileDown size={17} /></span><div><strong>Importar configuración existente</strong><span className="muted">{features.envImport ? 'Lee únicamente variables permitidas del archivo .env configurado y cifra el token como una conexión nueva. No modifica el archivo ni muestra el secreto.' : ENV_IMPORT_DISABLED_HINT}</span></div>{features.envImport ? <button className="btn" onClick={() => void importEnv()}>Importar .env del proyecto</button> : <Status value="Desactivada" tone="neutral" />}</div>
      <div className="settings-row"><span className="ic ok" aria-hidden="true"><Lock size={17} /></span><div><strong>Protección de cuenta heredada</strong><span className="muted">{features.legacyInterlock ? 'Los bloqueos previos se verifican antes de cualquier modo real. La aplicación nunca elimina bloqueos ni contadores externos.' : 'Desactivada: no se lee ninguna carpeta de otra herramienta. Se activa con SOCIAL_DESK_LEGACY_ACCOUNTS_DIR o SOCIAL_DESK_LEGACY_HOLD_USERNAMES.'}</span></div>{features.legacyInterlock ? <Status value="Interlock local activo" tone="good" /> : <Status value="No configurada" tone="neutral" />}</div>
    </div>
  </section>;
}

function MediaThumb({ item }: { item: Media }) {
  const [error, setError] = useState(false);
  const TypeIcon = item.mediaType === 'VIDEO' || item.mediaType === 'REELS' ? Clapperboard : item.mediaType === 'CAROUSEL_ALBUM' ? Layers : ImageIcon;
  return <div className="media-thumb-wrapper">
    {item.thumbnailUrl && !error ? <img src={item.thumbnailUrl} alt={item.caption ?? "Publicación"} loading="lazy" onError={() => setError(true)} /> : <div className="placeholder"><TypeIcon size={32} strokeWidth={1.5} /></div>}
    <div className="media-type-chip" title={mediaTypeLabel(item.mediaType) ?? undefined}><TypeIcon size={14} strokeWidth={2} aria-hidden="true" /></div>{mediaTypeLabel(item.mediaType) && <span className="visually-hidden">{mediaTypeLabel(item.mediaType)}</span>}
  </div>;
}

function MiniThumb({ item, size }: { item?: Media | { mediaType?: string | null; thumbnailUrl?: string | null } | null; size?: 'small' | 'mid' | 'recipe' | 'post' }) {
  const [error, setError] = useState(false);
  const cls = size === 'recipe' ? 'recipe-thumb' : size === 'post' ? 'post-thumb' : size === 'mid' ? 'media-thumb-mid' : 'media-thumb-small';
  const iconSize = size === 'small' || !size ? 16 : 22;
  if (!item) return <span className={`${cls} ph`}><ImageIcon size={iconSize} strokeWidth={1.5} aria-hidden="true" /></span>;
  const TypeIcon = item.mediaType === 'VIDEO' || item.mediaType === 'REELS' ? Clapperboard : item.mediaType === 'CAROUSEL_ALBUM' ? Layers : ImageIcon;
  if (item.thumbnailUrl && !error) return <img src={item.thumbnailUrl} alt="" className={cls} loading="lazy" onError={() => setError(true)} />;
  return <span className={`${cls} ph`}><TypeIcon size={iconSize} strokeWidth={1.5} aria-hidden="true" /></span>;
}
/* ---------- Shared pieces ---------- */

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function Metric({ label, value, note }: { label: string; value: number; note: string }) { return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
const STATE_LABELS: Record<string, string> = { SIMULATED: 'Simulado', QUEUED: 'En cola', SEND_INTENT_RECORDED: 'Intención registrada', SENDING: 'Enviando', SENT: 'Enviado', FAILED_RETRYABLE: 'Falló (reintentable)', FAILED_PERMANENT: 'Falló (definitivo)', UNKNOWN_OUTCOME: 'Resultado desconocido', EXPIRED: 'Expirado', SKIPPED: 'Omitido' };
function readbackSummary(event: { safeErrorCode?: string; details: Record<string, unknown> }) {
  if (event.details.observed === true) return event.details.observedMatches === true ? 'Lectura confirmada: el mensaje y los botones coinciden' : 'Lectura confirmada; el contenido no coincide por completo';
  return `No se pudo leer: ${event.safeErrorCode ?? 'readback_unavailable'}${readbackHint(event.safeErrorCode)}`;
}
const READBACK_HINTS: Record<string, string> = {
  meta_readback_sender_mismatch: 'El remitente no coincide con la cuenta',
  meta_readback_id_mismatch: 'El mensaje leído tiene otro ID',
  meta_readback_no_recipient: 'No se encontró destinatario',
};
function readbackHint(code?: string) { const hint = code ? READBACK_HINTS[code] : undefined; return hint ? ` (${hint})` : ''; }
function stateLabel(state: string) { return STATE_LABELS[state] ?? state; }
function queueTone(state: string): Tone {
  if (state === 'SENT') return 'good';
  if (state === 'FAILED_PERMANENT') return 'danger';
  if (state === 'FAILED_RETRYABLE' || state === 'UNKNOWN_OUTCOME') return 'warn';
  return 'neutral';
}
const TONE_ICON: Record<Tone, any> = { good: CheckCircle2, neutral: Circle, warn: AlertTriangle, danger: XCircle };
/** Color is never the only signal: each tone also has a glyph and always carries text. */
function Status({ value, tone }: { value: string; tone: Tone }) { const Icon = TONE_ICON[tone]; return <span className={`status-badge ${tone}`}><Icon size={14} strokeWidth={2.5} aria-hidden="true" />{value}</span>; }
function ConnectionBadge({ status }: { status: string }) {
  if (status === 'valid') return <Status value="Validada" tone="good" />;
  if (status === 'unvalidated') return <Status value="Sin validar" tone="neutral" />;
  if (status === 'invalid') return <Status value="Token inválido" tone="danger" />;
  if (status === 'disconnected') return <Status value="Desconectada" tone="neutral" />;
  return <Status value={status} tone="warn" />;
}
function Empty({ title, detail, action, actionLabel, primary, icon: Icon = Inbox, nani }: { title: string; detail: string; action?: () => void; actionLabel?: string; primary?: boolean; icon?: any; nani?: NaniState }) { return <div className={nani ? 'empty-state with-nani' : 'empty-state'}>{nani ? <Nani state={nani} size={84} decorative /> : <div className="empty-icon"><Icon size={20} strokeWidth={1.9} aria-hidden="true" /></div>}<strong>{title}</strong><p>{detail}</p>{action && <button className={primary ? 'button primary' : 'button secondary'} onClick={action}>{actionLabel}</button>}</div>; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
function safeErrorLabel(code: string) { const labels: Record<string, string> = { account_not_found: 'La cuenta indicada no existe.', connection_not_found: 'La conexión indicada no existe.', invalid_request: 'Revise los campos e inténtelo de nuevo.', origin_or_csrf_rejected: 'La solicitud local no superó la protección de origen.', operation_rejected: 'La operación fue rechazada por una condición de seguridad o estado.', account_scan_failed: 'No se pudo completar el análisis para una cuenta.', follow_gate_invalid: 'La opción «Pedir primero que me sigan» no es válida.', follow_gate_message_invalid: 'Revise el «Mensaje previo»: es obligatorio, de hasta 640 caracteres y solo admite las variables indicadas.', follow_gate_button_title_invalid: 'Revise el «Título del botón»: de 1 a 20 caracteres, sin enlaces ni saltos de línea.', follow_gate_retired: FOLLOW_GATE_RETIRED_LABEL, interactive_mode_retired: INTERACTIVE_RETIRED_LABEL, ...ATTACHMENT_ERROR_LABELS, ...AI_ERROR_LABELS }; return labels[code] ?? 'Revise el estado de la cuenta y vuelva a intentarlo.'; }

export function ModerationView({ onCelebrate, flagCounts, accountFilter, allAccounts, onSelectAccount, onNavigate, api, act, confirm, mode }: { onCelebrate?: () => void; flagCounts?: Dashboard['moderation']; accountFilter: string; allAccounts: any[]; onSelectAccount: (id: string) => void; onNavigate: (id: string) => void; api: any; act: any; confirm: any; mode: string }) {
  const [settings, setSettings] = useState<any>(null);
  const [flags, setFlags] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  // The default view is the «Mesa de revisión» deck, which shows PENDING flags; the list starts from every state.
  const [view, setView] = useState<'deck' | 'list'>('deck');
  const [flagState, setFlagState] = useState('PENDING');
  const [flagSource, setFlagSource] = useState('all');
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Presentational only: the flag shown in the detail pane, the mobile sheet, the left pane tab and the terms editor.
  const [activeId, setActiveId] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pane, setPane] = useState<'views' | 'rules' | 'ai'>('rules');
  const [termsOpen, setTermsOpen] = useState(false);
  const [aiRow, setAiRow] = useState<HTMLDivElement | null>(null);
  const slots = useContext(SlotContext);

  // Form fields
  const [enabled, setEnabled] = useState(false);
  const [blockedTerms, setBlockedTerms] = useState('');
  const [detectLinks, setDetectLinks] = useState(true);
  const [detectPhones, setDetectPhones] = useState(true);
  const [detectMentions, setDetectMentions] = useState(true);
  const [detectEmoji, setDetectEmoji] = useState(false);
  const [autoHideEnabled, setAutoHideEnabled] = useState(false);
  const [autoHideCategories, setAutoHideCategories] = useState<string[]>([]);

  const loadSettings = useCallback(async () => {
    if (accountFilter === 'all') return;
    try {
      const data = await api(`/api/moderation/settings?accountId=${encodeURIComponent(accountFilter)}`);
      setSettings(data);
      setEnabled(data.enabled);
      setBlockedTerms(data.blockedTerms.join('\n'));
      setDetectLinks(data.detectLinks);
      setDetectPhones(data.detectPhones);
      setDetectMentions(data.detectMentions);
      setDetectEmoji(data.detectEmoji);
      setAutoHideEnabled(data.autoHideEnabled);
      setAutoHideCategories(data.autoHideCategories);
    } catch {
      // Ignored
    }
  }, [api, accountFilter]);

  const loadFlags = useCallback(async () => {
    if (accountFilter === 'all') return;
    try {
      const query = new URLSearchParams({ accountId: accountFilter, limit: '50', offset: String(offset) });
      if (flagState !== 'all') query.set('state', flagState);
      if (flagSource !== 'all') query.set('source', flagSource);
      const data = await api(`/api/moderation/flags?${query}`);
      setFlags(data.items);
      setTotal(data.total);
      setSelectedIds([]);
      setFlagsLoaded(true);
    } catch {
      // Ignored
    }
  }, [api, accountFilter, offset, flagState, flagSource]);

  function showAiFlags() {
    setFlagSource('ai');
    setFlagState('PENDING');
    setOffset(0);
  }

  useEffect(() => {
    loadSettings();
    loadFlags();
  }, [loadSettings, loadFlags]);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    const terms = blockedTerms.split(/[\n,]+/).map(t => t.trim()).filter(Boolean);
    let confirmed = false;
    // Confirmation only when auto-hide escalates: enabled from disabled, or a new category is allowed.
    const autoHideEscalates = autoHideEnabled && (!settings?.autoHideEnabled
      || autoHideCategories.some((category) => !(settings?.autoHideCategories ?? []).includes(category)));
    if (autoHideEscalates) {
      if (!(await confirm({ title: 'Ocultar automáticamente', body: 'Los comentarios marcados en estas categorías se ocultarán solos cuando el modo real esté activo. Solo se aplica a comentarios publicados desde ahora. Nunca se borran solos.', confirmLabel: 'Autorizar' }))) {
        if (!settings?.autoHideEnabled) setAutoHideEnabled(false);
        return;
      }
      confirmed = true;
    }
    await act(async () => {
      await api('/api/moderation/settings', 'PUT', {
        accountId: accountFilter,
        enabled,
        blockedTerms: terms,
        detectLinks,
        detectPhones,
        detectMentions,
        detectEmoji,
        autoHideEnabled,
        autoHideCategories,
        confirmed
      });
      await loadSettings();
    }, 'Reglas de moderación guardadas.');
  }

  function toggleAutoCategory(cat: string) {
    setAutoHideCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  }

  
  const selectedStates = flags.filter((flag) => selectedIds.includes(flag.flagId)).map((flag) => String(flag.state));

  async function bulkAction(action: 'dismiss' | 'hide' | 'unhide' | 'delete') {
    if (!selectedIds.length) return;
    const confirmation = action === 'delete'
      ? { title: 'Borrar comentarios', body: `Vas a borrar ${selectedIds.length} comentarios. Borrar es permanente y no se puede deshacer.`, confirmLabel: 'Borrar', danger: true }
      : { title: `${{ dismiss: 'Descartar', hide: 'Ocultar', unhide: 'Mostrar' }[action]} comentarios`, body: `¿${{ dismiss: 'Descartar', hide: 'Ocultar', unhide: 'Mostrar' }[action]} ${selectedIds.length} comentarios seleccionados?${mode === 'dry' ? ' En modo prueba la acción solo se simula.' : ''}`, confirmLabel: { dismiss: 'Descartar', hide: 'Ocultar', unhide: 'Mostrar' }[action] };
    if (!(await confirm(confirmation))) return;
    let summary = 'Acción masiva aplicada.';
    const ok = await act(async () => {
      const data = await api('/api/moderation/flags/bulk', 'POST', { accountId: accountFilter, flagIds: selectedIds, action, confirmed: action === 'delete' });
      summary = bulkSummary(Array.isArray(data?.results) ? data.results as BulkResultView[] : []);
    }, () => summary);
    if (ok) {
      setSelectedIds([]);
      loadFlags();
    }
  }

  async function hideFlag(flagId: string) {
    await act(async () => {
      await api(`/api/moderation/flags/${flagId}/hide`, 'POST', { accountId: accountFilter });
      await loadFlags();
    }, 'Intento de ocultar registrado.');
  }

  async function unhideFlag(flagId: string) {
    await act(async () => {
      await api(`/api/moderation/flags/${flagId}/unhide`, 'POST', { accountId: accountFilter });
      await loadFlags();
    }, 'Intento de mostrar registrado.');
  }

  async function deleteFlag(flagId: string) {
    if (!(await confirm({ title: 'Borrar comentario', body: 'Borrar es permanente y no se puede deshacer. ¿Borrar este comentario?', confirmLabel: 'Borrar', danger: true }))) return;
    await act(async () => {
      await api(`/api/moderation/flags/${flagId}/delete`, 'POST', { accountId: accountFilter, confirmed: true });
      await loadFlags();
    }, 'Intento de borrar registrado.');
  }

  async function dismissFlag(flagId: string) {
    await act(async () => {
      await api(`/api/moderation/flags/${flagId}/dismiss`, 'POST', { accountId: accountFilter });
      await loadFlags();
    }, 'Comentario descartado.');
  }

  const active = flags.find((flag) => flag.flagId === activeId) ?? flags[0];
  const termChips = blockedTerms.split(/[\n,]+/).map((term) => term.trim()).filter(Boolean);

  // Presentational: a row with an action in flight ignores repeated shortcuts (the ref guards before React re-renders).
  const [busyId, setBusyId] = useState('');
  const busyRef = useRef('');
  async function runRowAction(flagId: string, action: (id: string) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = flagId; setBusyId(flagId);
    try { await action(flagId); } finally { busyRef.current = ''; setBusyId(''); }
  }
  // Switching account never keeps the previous account's list, selection or open sheet on screen.
  useEffect(() => { setFlags([]); setTotal(0); setSelectedIds([]); setActiveId(''); setSheetOpen(false); setFlagsLoaded(false); }, [accountFilter]);

  function showList() { setView('list'); setFlagState('all'); setFlagSource('all'); setOffset(0); setPane('views'); }
  function showDeck() { setView('deck'); setFlagState('PENDING'); setFlagSource('all'); setOffset(0); setPane((value) => value === 'views' ? 'rules' : value); }

  /** Deck delete: the 1.2 s hold is the explicit confirmation, so it calls the same endpoint with confirmed: true. */
  async function deleteFlagHeld(flagId: string) {
    await act(async () => {
      await api(`/api/moderation/flags/${flagId}/delete`, 'POST', { accountId: accountFilter, confirmed: true });
      await loadFlags();
    }, 'Intento de borrar registrado.');
  }

  // Optional shortcuts: H hides, D dismisses — only on an explicitly selected, visible flag (see shouldHandleShortcut).
  useEffect(() => {
    if (accountFilter === 'all' || view === 'deck') return;
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const selected = flags.find((flag) => flag.flagId === activeId);
      const action = shouldHandleShortcut({
        key: event.key, repeat: event.repeat, modifier: event.metaKey || event.ctrlKey || event.altKey,
        typing: Boolean(target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)),
        dialogOpen: Boolean(document.querySelector('.modal')), accountFilter, selectedId: activeId,
        visibleIds: flags.map((flag) => flag.flagId), state: selected?.state ?? '', busy: Boolean(busyRef.current),
        narrow: window.matchMedia('(max-width: 760px)').matches, sheetOpen,
      });
      if (!action || !selected) return;
      event.preventDefault();
      void runRowAction(selected.flagId, action === 'hide' ? hideFlag : dismissFlag);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (accountFilter === 'all') {
    return <section className="narrow-col" aria-labelledby="mod-all-title">
      <div className="section-h"><h3 id="mod-all-title">Reglas de moderación</h3><p className="muted">Elija una cuenta para configurar sus reglas.</p></div>
      {allAccounts.length ? <AccountPrompt id="mod-account-prompt" title="Elija una cuenta para moderar" detail="Las reglas se aplican individualmente." choices={allAccounts} onSelect={onSelectAccount} />
        : <Empty icon={ShieldCheck} title="Aún no hay cuentas" detail="Conecte Meta y elija una cuenta antes de configurar moderación." action={() => onNavigate('connections')} actionLabel="Ir a Conexiones" primary />}
    </section>;
  }

  const paneTabs: Array<[typeof pane, string]> = view === 'deck' ? [['rules', 'Reglas'], ['ai', 'IA']] : [['views', 'Vistas'], ['rules', 'Reglas'], ['ai', 'IA']];
  return <SlotContext.Provider value={{ topbar: slots.topbar, aiRow }}>
  {view === 'list' && <PageActions><button className="btn" onClick={showDeck}><Layers size={15} aria-hidden="true" /> <span className="btn-label">Mesa de revisión</span></button></PageActions>}
  <div className={view === 'deck' ? 'inbox deck-mode' : 'inbox'}>
    <aside className="mod-pane" aria-label="Vistas y reglas de moderación">
      <div className="pane-tabs" role="tablist" aria-label="Panel de moderación">
        {paneTabs.map(([id, label]) => <button key={id} type="button" role="tab" id={`mod-tab-${id}`} aria-selected={pane === id} aria-controls={`mod-pane-${id}`} className={pane === id ? 'pane-tab active' : 'pane-tab'} onClick={() => setPane(id)}>{label}</button>)}
      </div>
      <div className="pane-body" id="mod-pane-views" role="tabpanel" aria-labelledby="mod-tab-views" hidden={pane !== 'views'}>
        <div className="views" role="group" aria-label="Estado de la marca">
          {MOD_VIEWS.map(([value, label, Icon]) => <button key={value} type="button" className={flagState === value ? 'view-item active' : 'view-item'} aria-pressed={flagState === value} onClick={() => { setFlagState(value); setOffset(0); }}><Icon size={15} aria-hidden="true" /><span>{label}</span>{/* Counts come from every source: shown only with «Todas» so they never contradict the filtered list. */}{flagCounts && flagSource === 'all' && <span className="view-count">{flagCount(flagCounts, value)}</span>}</button>)}
        </div>
        <div className="pane-group">
          <span className="pane-label">Origen</span>
          <div className="segmented" role="group" aria-label="Origen de la marca">
            {([['all', 'Todas'], ['rules', 'Reglas'], ['ai', 'IA']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={flagSource === value} className={flagSource === value ? 'seg active' : 'seg'} onClick={() => { setFlagSource(value); setOffset(0); }}>{value === 'ai' && <Sparkles size={13} aria-hidden="true" />}{label}</button>)}
          </div>
        </div>
      </div>
      <form className="pane-body mod-rules" id="mod-pane-rules" role="tabpanel" aria-labelledby="mod-tab-rules" hidden={pane !== 'rules'} onSubmit={saveSettings}>
        <div className="pane-intro">
          <h3>Reglas de moderación</h3>
          <p className="muted">Defina qué comentarios se marcan en esta cuenta. Marcar no oculta nada por sí solo.</p>
        </div>
        <label className="switch-row strong">
          <span className="switch-row-text"><strong>Activar moderación en esta cuenta</strong><span>Cada escaneo revisa los comentarios nuevos con estas reglas.</span></span>
          <input type="checkbox" role="switch" className="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        </label>
        <div className="pane-group">
          <span className="pane-label">Detectores automáticos</span>
          <label className="switch-row"><span className="switch-row-text"><strong>Enlaces</strong><span>Detecta URLs (http, www, bit.ly)</span></span><input type="checkbox" role="switch" className="switch" checked={detectLinks} onChange={e => setDetectLinks(e.target.checked)} /></label>
          <label className="switch-row"><span className="switch-row-text"><strong>Teléfonos</strong><span>Detecta secuencias de números</span></span><input type="checkbox" role="switch" className="switch" checked={detectPhones} onChange={e => setDetectPhones(e.target.checked)} /></label>
          <label className="switch-row"><span className="switch-row-text"><strong>Menciones</strong><span>Detecta 3 o más cuentas @mencionadas</span></span><input type="checkbox" role="switch" className="switch" checked={detectMentions} onChange={e => setDetectMentions(e.target.checked)} /></label>
          <label className="switch-row"><span className="switch-row-text"><strong>Emojis</strong><span>Detecta spam visual o emojis repetidos</span></span><input type="checkbox" role="switch" className="switch" checked={detectEmoji} onChange={e => setDetectEmoji(e.target.checked)} /></label>
        </div>
        <div className="pane-group">
          <div className="pane-label-row"><span className="pane-label">Palabras o frases prohibidas</span><button type="button" className="btn-link text-button" aria-expanded={termsOpen} aria-controls="mod-terms-editor" onClick={() => setTermsOpen((value) => !value)}>{termsOpen ? 'Listo' : 'Editar'}</button></div>
          {termChips.length ? <div className="term-chips">{termChips.map((term, index) => <span className="kw-chip" key={`${term}-${index}`}>{term}</span>)}</div> : <p className="hint">Aún no hay palabras prohibidas.</p>}
          <div id="mod-terms-editor" hidden={!termsOpen}>
            <Field label="Palabras o frases prohibidas">
              <textarea value={blockedTerms} onChange={e => setBlockedTerms(e.target.value)} placeholder="estafa, ladrones..." rows={4} />
            </Field>
            <p className="hint mod-hint">Una por línea o separadas por coma. No importan mayúsculas ni tildes.</p>
          </div>
        </div>
        <div className="pane-group mod-auto">
          <label className="switch-row">
            <span className="switch-row-text"><strong>Ocultar automáticamente</strong><span>Solo con el modo real activo. Nunca se borra nada solo.</span></span>
            <input type="checkbox" role="switch" className="switch" disabled={!enabled} checked={enabled && autoHideEnabled} onChange={e => setAutoHideEnabled(e.target.checked)} />
          </label>
          {enabled && autoHideEnabled && <div className="mod-auto-cats">
            {AUTO_HIDE_OPTIONS.map((option) => <label key={option.value} className={autoHideCategories.includes(option.value) ? 'cat-chip on' : 'cat-chip'}><input type="checkbox" checked={autoHideCategories.includes(option.value)} onChange={() => toggleAutoCategory(option.value)} /> {option.label}</label>)}
            <p className="hint mod-auto-note">Las categorías «(IA)» vienen de la revisión con IA. IA puede equivocarse: active estas solo si revisó varios resultados. Las quejas legítimas nunca se ocultan solas.</p>
          </div>}
        </div>
        <div className="pane-save">
          <button className="btn-main" type="submit">Guardar reglas</button>
        </div>
      </form>
      <div className="pane-body" id="mod-pane-ai" role="tabpanel" aria-labelledby="mod-tab-ai" hidden={pane !== 'ai'}>
        <AiReviewPanel key={accountFilter} accountId={accountFilter} api={api} act={act} confirm={confirm} onShowAiFlags={showAiFlags} onFlagsChanged={loadFlags} onConfigure={() => setPane('ai')} />
      </div>
    </aside>
    {view === 'deck' ? <ModerationDeck flags={flags.filter((flag) => flag.state === 'PENDING')} total={flagState === 'PENDING' ? total : 0} loaded={flagsLoaded && flagState === 'PENDING'} accountFilter={accountFilter} busyId={busyId} mode={mode}
      onHide={(id) => runRowAction(id, hideFlag)} onDismiss={(id) => runRowAction(id, dismissFlag)} onDelete={(id) => runRowAction(id, deleteFlagHeld)}
      onShowList={showList} onCleared={() => onCelebrate?.()} setAiRow={setAiRow} ago={shortAgo} category={categoryLabel} reasons={reasonsText} complaintHint={AI_COMPLAINT_HINT} /> : <>
    <section className="mod-list" aria-labelledby="flags-title">
      <div className="list-h">
        <input type="checkbox" aria-label="Seleccionar todo" checked={flags.length > 0 && selectedIds.length === flags.length} onChange={e => setSelectedIds(e.target.checked ? flags.map(f => f.flagId) : [])} />
        <h3 id="flags-title" className="list-h-title">Comentarios marcados <span className="count-badge">{total}</span>{selectedIds.length > 0 && <span className="list-h-selected">{selectedIds.length} seleccionados</span>}</h3>
        <div className="list-h-actions" role="toolbar" aria-label="Acciones para los seleccionados">
          {selectedIds.length > 0 && <>
            {bulkAllowed('hide', selectedStates) && <button className="btn-icon ghost" onClick={() => bulkAction('hide')} title="Ocultar seleccionados" aria-label="Ocultar seleccionados"><EyeOff size={16} /></button>}
            {bulkAllowed('unhide', selectedStates) && <button className="btn-icon ghost" onClick={() => bulkAction('unhide')} title="Mostrar seleccionados" aria-label="Mostrar seleccionados"><Eye size={16} /></button>}
            {bulkAllowed('dismiss', selectedStates) && <button className="btn-icon ghost" onClick={() => bulkAction('dismiss')} title="Descartar seleccionados" aria-label="Descartar seleccionados"><Check size={16} /></button>}
            {bulkAllowed('delete', selectedStates) && <button className="btn-icon ghost danger" onClick={() => bulkAction('delete')} title="Borrar seleccionados" aria-label="Borrar seleccionados"><Trash2 size={16} /></button>}
            <span className="list-h-sep" aria-hidden="true" />
          </>}
          <button className="btn-icon ghost" onClick={() => loadFlags()} title="Actualizar" aria-label="Actualizar"><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="ai-row" ref={setAiRow} />
      {mode === 'dry' && <p className="mod-dry-note"><FlaskConical size={13} aria-hidden="true" /> Modo prueba: las acciones se simulan, no se ocultan ni borran comentarios reales.</p>}
      {!flags.length ? <Empty nani="happy" title="No tengo comentarios marcados." detail="Active la moderación y defina palabras prohibidas; los comentarios marcados aparecerán aquí tras el próximo escaneo." action={() => setPane('rules')} actionLabel="Revisar reglas" /> :
        <div className="mod-rows">
          {flags.map(flag => {
            const isActive = active?.flagId === flag.flagId;
            return <div className={isActive ? 'mod-row active' : selectedIds.includes(flag.flagId) ? 'mod-row checked' : 'mod-row'} key={flag.flagId}>
              <input type="checkbox" aria-label={`Seleccionar comentario de @${flag.comment?.username || 'usuario'}`} checked={selectedIds.includes(flag.flagId)} onChange={e => setSelectedIds(e.target.checked ? [...selectedIds, flag.flagId] : selectedIds.filter(id => id !== flag.flagId))} />
              <button type="button" className="mod-row-main" aria-pressed={isActive} onClick={() => { setActiveId(flag.flagId); setSheetOpen(true); }}>
                <RingAvatar username={flag.comment?.username} />
                <span className="mod-row-body">
                  <span className="mod-row-head"><b>@{flag.comment?.username || 'Usuario'}</b><span className="mono time" title={formatDate(flag.createdAt)}>{shortAgo(flag.comment?.createdAt ?? flag.createdAt)}</span></span>
                  <span className="mod-row-text">{flag.comment?.text}</span>
                  <span className="chips">
                    <span className={flag.category === 'ai_complaint' ? 'chip warn' : 'chip bad'}>{categoryLabel(flag.category)}</span>
                    {flag.source === 'ai' && <span className="chip ai"><Sparkles size={11} aria-hidden="true" /> IA</span>}
                    {flag.state !== 'PENDING' && <span className={`chip ${flagTone(flag.state)}`}>{moderationStateLabel(flag.state)}</span>}
                  </span>
                </span>
              </button>
            </div>;
          })}
        </div>
      }
      {total > 50 && <div className="pagination">
        <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Anteriores</button>
        <span className="mono">Mostrando {offset + 1} - {Math.min(offset + 50, total)} de {total}</span>
        <button className="btn small" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Siguientes</button>
      </div>}
    </section>
    <section className={sheetOpen ? 'mod-detail open' : 'mod-detail'} aria-label="Detalle del comentario">
      {active ? (() => {
        const flag = active;
        const explicit = flag.flagId === activeId;
        const allowed = availableActions(flag.state);
        const reasons = reasonsText(flag.reasons);
        return <>
          <button type="button" className="btn small sheet-close" onClick={() => setSheetOpen(false)}><ArrowLeft size={15} aria-hidden="true" /> Volver a la lista</button>
          <div className="post-card">
            <MiniThumb size="post" item={flag.media ?? null} />
            <div className="post-card-body">
              <span className="muted small">En tu publicación{flag.media?.caption ? <> «{shortCaption(flag.media.caption, 60)}»</> : ''}{flag.media?.permalink && <> · <a href={flag.media.permalink} target="_blank" rel="noreferrer">Ver en Instagram</a></>}</span>
              <div className="comment-bubble"><RingAvatar username={flag.comment?.username} /><div><b>@{flag.comment?.username || 'Usuario'}</b> <span className="muted mono small">{formatDate(flag.comment?.createdAt ?? flag.createdAt)}</span><p>{flag.comment?.text}</p></div></div>
            </div>
          </div>
          <div className={flag.category === 'ai_complaint' ? 'why complaint' : 'why'}><ShieldAlert size={16} aria-hidden="true" /><span><b>Por qué se marcó:</b> {categoryLabel(flag.category)}{reasons ? ` — ${reasons}` : ''}.</span></div>
          {flag.category === 'ai_complaint' && <p className="ai-complaint-hint">{AI_COMPLAINT_HINT}</p>}
          <div className="acts">
            {allowed.hide && <button className="button primary" disabled={busyId === flag.flagId} onClick={() => void runRowAction(flag.flagId, hideFlag)}><EyeOff size={16} aria-hidden="true" /> Ocultar {explicit && <kbd aria-hidden="true">H</kbd>}</button>}
            {allowed.unhide && <button className="btn" disabled={busyId === flag.flagId} onClick={() => void runRowAction(flag.flagId, unhideFlag)}><Eye size={16} aria-hidden="true" /> Mostrar</button>}
            {allowed.dismiss && <button className="btn" disabled={busyId === flag.flagId} onClick={() => void runRowAction(flag.flagId, dismissFlag)}><Check size={16} aria-hidden="true" /> Está bien, descartar {explicit && <kbd aria-hidden="true">D</kbd>}</button>}
            {allowed.delete && <button className="btn btn-danger" disabled={busyId === flag.flagId} onClick={() => void runRowAction(flag.flagId, deleteFlag)}><Trash2 size={16} aria-hidden="true" /> Borrar</button>}
          </div>
          <div className="history">
            <b>Historial</b>
            <div><Flag size={14} aria-hidden="true" /> Marcado por {flag.source === 'ai' ? 'IA' : 'reglas'} · <span className="mono">{formatDate(flag.createdAt)}</span></div>
            {flag.lastAction && <div><History size={14} aria-hidden="true" /> Última acción: {MOD_ACTION_LABELS[flag.lastAction] ?? flag.lastAction} · <span className="mono">{formatDate(flag.updatedAt)}</span></div>}
            <div><Circle size={14} aria-hidden="true" /> Estado: <Status value={moderationStateLabel(flag.state)} tone={flag.state === 'PENDING' ? 'warn' : flag.state === 'HIDDEN' || flag.state === 'DELETED' || flag.state === 'DISMISSED' ? 'good' : flag.state === 'SIMULATED' ? 'neutral' : 'danger'} />{flag.safeErrorCode && <span className="muted mono small">({flag.safeErrorCode})</span>}</div>
          </div>
        </>;
      })() : <Empty icon={ShieldCheck} title="Nada seleccionado" detail="Elija un comentario de la lista para ver por qué se marcó y decidir qué hacer." />}
    </section>
    </>}
  </div>
  </SlotContext.Provider>;
}

/** Moderation views: the same state filter values the API accepts. */
const MOD_VIEWS: ReadonlyArray<[string, string, any]> = [
  ['all', 'Todos los estados', ListFilter], ['PENDING', 'Pendientes', Flag], ['HIDDEN', 'Ocultos', EyeOff], ['SIMULATED', 'Simulados', FlaskConical],
  ['FAILED', 'Fallidos', XCircle], ['UNKNOWN_OUTCOME', 'Por revisar', AlertTriangle], ['DISMISSED', 'Descartados', Archive], ['DELETED', 'Borrados', Trash2], ['VISIBLE', 'Visibles', Eye],
];
const MOD_ACTION_LABELS: Record<string, string> = { hide: 'ocultar', unhide: 'mostrar', delete: 'borrar', dismiss: 'descartar' };
function flagTone(state: string) { return state === 'HIDDEN' || state === 'DELETED' || state === 'DISMISSED' ? 'ok' : state === 'SIMULATED' || state === 'VISIBLE' ? 'neutral' : state === 'UNKNOWN_OUTCOME' ? 'warn' : 'bad'; }
/** Compact relative time for dense rows ("2 h", "3 d"); the full date stays in the title. */
function shortAgo(value?: string | null) {
  const time = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

type LocalStatusView = { models: Array<LocalModelEntryView & { label: string }>; download?: DownloadView | null };

type AiJobView = { state: string; errorCode?: string; progress?: { chunksDone: number; chunksTotal: number; commentsSent: number; flagged: number; invalidOutput: number; chunksFailed?: number; commentsTotal?: number; truncated?: boolean } };

/** "Revisión con IA": engine selector (off by default), Gemini key/model, privacy notice and the batch review job. */
function AiReviewPanel({ accountId, api, act, confirm, onShowAiFlags, onFlagsChanged, onConfigure }: { accountId: string; api: Api; act: Act; confirm: Confirm; onShowAiFlags(): void; onFlagsChanged(): void; onConfigure?(): void }) {
  const [settings, setSettings] = useState<{ engine: string; model: string; localModel?: string; localModelInstalled?: boolean; hasApiKey: boolean; apiKeyHint: string | null; consentAt: string | null; availableModels: string[] } | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalStatusView | null>(null);
  // "Modelo local" was picked but no model is installed yet: show the cards without saving the engine.
  const [localPicked, setLocalPicked] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [reviewWindow, setReviewWindow] = useState('7d');
  const [job, setJob] = useState<AiJobView | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const wasRunning = useRef(false);

  const loadAll = useCallback(async () => {
    try {
      const [nextSettings, nextJob] = await Promise.all([
        api(`/api/moderation/ai-settings?accountId=${encodeURIComponent(accountId)}`),
        api(`/api/moderation/ai-review?accountId=${encodeURIComponent(accountId)}`),
      ]);
      setSettings(nextSettings);
      setJob(nextJob?.state && nextJob.state !== 'idle' ? nextJob : null);
    } catch {
      // The panel stays in its last known state.
    }
  }, [api, accountId]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const loadLocal = useCallback(async () => {
    try {
      const next = await api('/api/moderation/ai-local/status');
      setLocalStatus(next && Array.isArray(next.models) ? next : null);
    } catch {
      // Keep the last known cards.
    }
  }, [api]);

  const showLocal = localPicked || settings?.engine === 'local';
  useEffect(() => { if (showLocal) void loadLocal(); }, [showLocal, loadLocal]);

  const downloading = localStatus?.download?.state === 'running';
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(async () => {
      try {
        const next = await api('/api/moderation/ai-local/status');
        setLocalStatus(next && Array.isArray(next.models) ? next : null);
        if (next?.download?.state !== 'running') void loadAll();
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(timer);
  }, [downloading, api, loadAll]);

  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) onFlagsChanged();
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(async () => {
      try { setJob(await api(`/api/moderation/ai-review?accountId=${encodeURIComponent(accountId)}`)); } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [running, api, accountId, onFlagsChanged]);

  async function chooseEngine(engine: string) {
    if (!settings) return;
    if (engine === 'local' && !settings.localModelInstalled) {
      // Nothing to save yet: the engine is stored once a model is installed and chosen.
      setLocalPicked(true);
      return;
    }
    setLocalPicked(false);
    if (engine === settings.engine) return;
    let confirmed = false;
    if (engine === 'gemini' && !settings.consentAt) {
      if (!(await confirm({ title: 'Activar revisión con Gemini', body: AI_PRIVACY_NOTICE, confirmLabel: 'Entiendo, activar' }))) return;
      confirmed = true;
    }
    await act(async () => {
      setSettings(await api('/api/moderation/ai-settings', 'PUT', { accountId, engine, confirmed }));
    }, engine === 'off' ? 'Revisión con IA desactivada.' : engine === 'local' ? 'Revisión con el modelo local activada.' : 'Revisión con Gemini activada.');
  }

  async function activateLocalModel(model: string) {
    const ok = await act(async () => {
      setSettings(await api('/api/moderation/ai-settings', 'PUT', { accountId, engine: 'local', model }));
    }, 'Revisión con el modelo local activada.');
    if (ok) setLocalPicked(false);
  }

  async function downloadModel(model: string) {
    await act(async () => {
      setLocalStatus(await api('/api/moderation/ai-local/download', 'POST', { model }));
    }, 'Descarga iniciada.');
  }

  async function cancelDownload() {
    await act(async () => {
      setLocalStatus(await api('/api/moderation/ai-local/download/cancel', 'POST', {}));
    }, 'Descarga cancelada. Podrá reanudarla después.');
  }

  async function deleteModel(entry: LocalModelEntryView & { label: string }) {
    const size = (entry.sizeBytes / 1e9).toFixed(1).replace('.', ',');
    if (!(await confirm({ title: 'Borrar modelo', body: `Se borrará el archivo del modelo (${size} GB) de este equipo. Podrá descargarlo de nuevo cuando quiera.`, confirmLabel: 'Borrar', danger: true }))) return;
    const ok = await act(async () => {
      setLocalStatus(await api('/api/moderation/ai-local/delete', 'POST', { model: entry.id, confirmed: true }));
    }, 'Modelo borrado.');
    if (ok) await loadAll();
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!settings || !apiKey.trim()) return;
    const ok = await act(async () => {
      setSettings(await api('/api/moderation/ai-settings', 'PUT', { accountId, engine: settings.engine, apiKey: apiKey.trim() }));
    }, 'API key guardada (cifrada en este equipo).');
    if (ok) { setApiKey(''); setTestMessage(''); }
  }

  async function removeKey() {
    if (!settings) return;
    if (!(await confirm({ title: 'Borrar API key', body: 'Se borrará la API key guardada para esta cuenta.', confirmLabel: 'Borrar', danger: true }))) return;
    await act(async () => {
      setSettings(await api('/api/moderation/ai-settings', 'PUT', { accountId, engine: settings.engine, apiKey: '' }));
    }, 'API key borrada.');
  }

  async function chooseModel(model: string) {
    if (!settings) return;
    await act(async () => {
      setSettings(await api('/api/moderation/ai-settings', 'PUT', { accountId, engine: settings.engine, model }));
    }, 'Modelo guardado.');
  }

  async function testKey() {
    setTestMessage('Probando…');
    try {
      const result = await api('/api/moderation/ai-settings/test', 'POST', { accountId });
      setTestMessage(result.ok ? 'La key funciona.' : (AI_ERROR_LABELS[result.errorCode] ?? 'La key no funcionó.'));
    } catch (cause) {
      setTestMessage(AI_ERROR_LABELS[cause instanceof Error ? cause.message : ''] ?? 'No se pudo probar la key.');
    }
  }

  async function startReview() {
    await act(async () => {
      setJob(await api('/api/moderation/ai-review', 'POST', { accountId, window: reviewWindow }));
    }, 'Revisión con IA iniciada.');
  }

  async function stopReview() {
    await act(async () => {
      setJob(await api('/api/moderation/ai-review/stop', 'POST', { accountId }));
    }, 'Deteniendo la revisión…');
  }

  const engine = localPicked ? 'local' : settings?.engine ?? 'off';
  const savedEngine = settings?.engine ?? 'off';
  const { canReview, hint: disabledHint } = aiReviewGate({
    savedEngine, localPicked, running, hasApiKey: Boolean(settings?.hasApiKey), localModelInstalled: Boolean(settings?.localModelInstalled),
  });
  const engines: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: 'off', label: 'Desactivada' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'local', label: 'Modelo local' },
  ];

  return <section className="ai-panel" aria-labelledby="ai-review-title">
    <div className="pane-intro">
      <h3 id="ai-review-title"><Sparkles size={16} aria-hidden="true" /> Revisión con IA</h3>
      <p className="muted">Marca insultos, odio, spam y quejas. Solo marca: ocultar o borrar sigue siendo su decisión.</p>
    </div>
    <div className="ai-engines" role="radiogroup" aria-label="Motor de IA">
      {engines.map((option) => <button key={option.value} type="button" role="radio" aria-checked={engine === option.value} disabled={option.disabled || !settings || running}
        className={engine === option.value ? 'ai-engine active' : 'ai-engine'} onClick={() => chooseEngine(option.value)}>{option.label}</button>)}
    </div>
    {running && <p className="hint ai-engine-locked">Detenga la revisión para cambiar el motor.</p>}
    {engine !== 'local' && <p className="ai-privacy" role="note">{AI_PRIVACY_NOTICE}</p>}
    {engine === 'local' && settings && <div className="ai-local">
      <p className="ai-local-note" role="note"><ShieldCheck size={16} aria-hidden="true" /> {AI_LOCAL_PRIVACY_NOTE}</p>
      <p className="hint"><Cpu size={14} aria-hidden="true" /> {AI_LOCAL_RESOURCE_NOTE}</p>
      <div className="ai-local-models">
        {(localStatus?.models ?? []).map((entry) => {
          const card = localModelCardState(entry, localStatus?.download);
          const info = LOCAL_MODEL_INFO[entry.id] ?? { title: entry.label, detail: '' };
          const inUse = savedEngine === 'local' && settings.localModel === entry.id;
          return <article key={entry.id} className={inUse ? 'ai-local-card in-use' : 'ai-local-card'} aria-label={info.title}>
            <div className="ai-local-card-head">
              <strong>{info.title}</strong>
              {card.kind === 'installed' && <span className="ai-installed"><CheckCircle2 size={14} aria-hidden="true" /> Instalado</span>}
            </div>
            <p className="muted">{info.detail}</p>
            {card.kind === 'downloading' && <div className="ai-download">
              <div className="progress-track" role="progressbar" aria-label="Progreso de la descarga" aria-valuemin={0} aria-valuemax={100} aria-valuenow={card.percent ?? 0} aria-valuetext={card.progressText}>
                <div className="progress-fill" style={{ width: `${card.percent ?? 0}%` }} />
              </div>
              <p className="progress-text">{card.progressText}</p>
            </div>}
            {card.message && <p className={card.kind === 'failed' ? 'hint ai-local-error' : 'hint'} role={card.kind === 'failed' ? 'alert' : undefined}>{card.message}</p>}
            <div className="ai-local-actions">
              {(card.kind === 'idle' || card.kind === 'failed' || card.kind === 'cancelled') && <button className="btn small" type="button" disabled={!card.canDownload} onClick={() => downloadModel(entry.id)}><Download size={14} aria-hidden="true" /> {card.downloadLabel}</button>}
              {card.canCancel && <button className="btn small" type="button" onClick={cancelDownload}>Cancelar</button>}
              {card.kind === 'installed' && (inUse
                ? <span className="ai-in-use">En uso</span>
                : <button className="btn small" type="button" disabled={running} onClick={() => activateLocalModel(entry.id)}>Usar este modelo</button>)}
              {card.canDelete && <button className="btn-link" type="button" disabled={running} onClick={() => deleteModel(entry)}>Borrar modelo</button>}
            </div>
          </article>;
        })}
        {!localStatus && <p className="hint">Cargando modelos…</p>}
      </div>
    </div>}
    {engine === 'gemini' && settings && <div className="ai-gemini">
      <form className="ai-key-row" onSubmit={saveKey}>
        <Field label="API key de Gemini">
          <input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings.hasApiKey ? `Guardada (${settings.apiKeyHint ?? '…'})` : 'Pegue aquí su API key'} />
        </Field>
        <div className="ai-key-actions">
          <button className="btn small" type="submit" disabled={!apiKey.trim()}><KeyRound size={14} aria-hidden="true" /> Guardar key</button>
          <button className="btn small" type="button" disabled={!settings.hasApiKey} onClick={testKey}>Probar key</button>
          {settings.hasApiKey && <button className="btn-link" type="button" onClick={removeKey} disabled={running}>Borrar key</button>}
        </div>
      </form>
      <p className="hint"><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Obtener una key gratis</a> en Google AI Studio. La key se guarda cifrada en este equipo y nunca se muestra completa; pegue otra para reemplazarla.</p>
      {testMessage && <p className="hint" role="status">{testMessage}</p>}
      <Field label="Modelo">
        <select value={settings.model} onChange={(event) => chooseModel(event.target.value)}>
          {settings.availableModels.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </Field>
    </div>}
    <PageActions><button className="button primary" type="button" aria-label="Revisar comentarios negativos" title={!canReview && disabledHint ? disabledHint : undefined} disabled={!canReview} onClick={startReview}><Sparkles size={15} aria-hidden="true" /> <span className="btn-label">Revisar comentarios negativos</span></button></PageActions>
    <AiRowSlot>
      <div className="ai-run">
        <span className="ai-run-label"><Sparkles size={13} aria-hidden="true" /> Revisión con IA</span>
        <label className="ai-window">
          <span>Comentarios de</span>
          <select value={reviewWindow} onChange={(event) => setReviewWindow(event.target.value)} disabled={running}>
            {Object.entries(AI_WINDOW_LABELS).map(([value, label]) => <option key={value} value={value}>Últimos {label}</option>)}
          </select>
        </label>
        {!canReview && !running && disabledHint && <span className="hint ai-run-hint">{disabledHint}{onConfigure && <> <button type="button" className="btn-link text-button" onClick={onConfigure}>Configurar IA</button></>}</span>}
        {job && !running && job.progress && <span className="ai-summary">{aiJobSummary({ state: job.state, errorCode: job.errorCode, progress: job.progress })}{job.progress.flagged > 0 && <button className="chip-button" type="button" onClick={onShowAiFlags}>Ver solo los marcados por IA</button>}</span>}
      </div>
      {running && job?.progress && <div className="scan-progress ai-progress">
        <div className="progress-track" role="progressbar" aria-label="Progreso de la revisión con IA" aria-valuemin={0} aria-valuemax={100} aria-valuenow={aiProgressPercent(job.progress)} aria-valuetext={aiProgressText(job.progress)}>
          <div className="progress-fill" style={{ width: `${aiProgressPercent(job.progress)}%` }} />
        </div>
        <div className="ai-progress-row">
          <p className="progress-text"><strong>{aiProgressText(job.progress)}</strong></p>
          <button className="btn small" type="button" onClick={stopReview}><Pause size={14} aria-hidden="true" /> Detener</button>
        </div>
        <p className="hint">{savedEngine === 'local' ? 'El modelo local revisa los lotes en este equipo, uno tras otro.' : 'Se envía un lote cada pocos segundos para respetar el límite gratuito.'}</p>
      </div>}
    </AiRowSlot>
  </section>;
}
