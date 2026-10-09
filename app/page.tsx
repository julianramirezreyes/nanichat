'use client';

import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoSelectAccount } from './account-filter';
import { mediaLabel, mediaTypeLabel, shortCaption, shortId } from './media-label';
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
import { PUBLIC_REPLY_SAMPLE_USERNAME, describePublicReply, parseVariantLines, previewExamples, publicReplyErrorHint, type PublicReplyDto, variantCountLabel } from './public-reply';

type Account = { accountId: string; connectionId: string; username: string; status: string; monitoringPaused: boolean; sendHoldReason?: string | null; last_sync?: string; last_error?: string; coverage?: string };
type Connection = { id: string; name: string; login_kind: string; app_id?: string | null; graph_version: string; status: string; last_validated_at: string | null };
type Media = { accountId: string; mediaId: string; permalink?: string; publishedAt?: string; caption?: string | null; mediaType?: string | null };
type ScanJob = { id: string; status: string; createdAt?: string; result?: any; progress?: ScanProgressDto; errorCode?: string };
const SCAN_JOB_KEY = 'social-desk.activeScanJob';
type Automation = { automationId: string; accountId: string; mediaId: string | null; scope?: 'media' | 'account'; name: string; status: string; realEnabled: boolean; keywords: Array<{ phrase: string }>; buttons?: Array<{ title: string; url: string }>; replyText?: string; matchMode?: 'exact' | 'contains'; publicReplyEnabled?: boolean; publicReplyVariants?: string[]; followGateEnabled?: boolean; followGateMessage?: string; followGateButtonTitle?: string; resourceAttachmentKind?: string; resourceAttachmentUrl?: string };
type AttachmentDto = { kind: string; url: string };
type PartDto = { state: string; safeErrorCode: string | null; attempts: number };
type FollowGateSession = { state: string; buttonTitle: string | null; gateSentAt: string | null; tapAt: string | null; windowExpiresAt: string | null; nextPollAt: string | null; pollCount: number; resourceMessageId: string | null; lastErrorCode: string | null; attachment?: AttachmentDto; parts?: { attachment: PartDto; text: PartDto } };
type QueueItem = { id: string; accountId: string; username: string; commentId: string; commentUsername?: string | null; commentText?: string; payload?: { text?: string; buttons?: Array<{ title: string; url: string }>; followGate?: { buttonTitle: string; attachment?: AttachmentDto; resource: { text: string; buttons: Array<{ title: string; url: string }> } } }; state: string; attemptCount: number; messageId: string | null; safeErrorCode: string | null; createdAt: string; publicReply?: PublicReplyDto | null; followGate?: FollowGateSession | null };
type Dashboard = { accounts: Account[]; queue: Array<{ state: string; count: number }>; automations: Array<{ status: string; count: number }>; dryRun: boolean; monitoringEnabled: boolean };
type Api = (path: string, method?: string, body?: Record<string, unknown>) => Promise<any>;
/** Runs an operation, shows feedback, refreshes data. Resolves true only when the operation succeeded. */
type Act = (operation: () => Promise<unknown>, message: string) => Promise<boolean>;
type ConfirmOptions = { title: string; body: string; confirmLabel: string; danger?: boolean };
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
type Tone = 'good' | 'neutral' | 'warn' | 'danger';

/** Thrown inside an `act` operation when the user declines a confirmation: no feedback, no refresh. */
class Cancelled extends Error {}

const sections = [
  ['dashboard', 'Resumen', 'Vea de un vistazo qué está pasando y qué falta por configurar.'],
  ['connections', 'Conexiones', 'Conecte su token de Meta y elija la cuenta de Instagram que desea administrar.'],
  ['media', 'Publicaciones', 'Publicaciones de la cuenta elegida; se usan para crear automatizaciones.'],
  ['automations', 'Automatizaciones', 'Reglas que responden por mensaje privado a los comentarios con ciertas palabras clave.'],
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
    try { await operation(); setNotice(message); await refresh(); return true; }
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

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">S</span><span><strong>Social Desk</strong><small>Operación local</small></span></div>
      <nav aria-label="Navegación principal">{sections.map(([id, label]) => <button key={id} className={section === id ? 'nav-item active' : 'nav-item'} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>{label}</button>)}</nav>
      <div className="sidebar-foot"><span className="status-dot" /> Solo en este equipo</div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div><span className="eyebrow">ESPACIO DE TRABAJO</span><h1>{current[1]}</h1><p className="page-desc">{current[2]}</p></div>
        <div className="top-actions"><label className="account-picker"><span>Cuenta</span><select aria-label="Filtrar por cuenta" value={accountFilter} onChange={(event) => chooseAccount(event.target.value)}><option value="all">Todas las cuentas</option>{(allAccounts.length ? allAccounts : accounts).map((account) => <option key={account.accountId} value={account.accountId}>@{account.username}</option>)}</select></label>
          {mode === 'checking'
            ? <button className="mode-pill checking-pill" disabled aria-disabled="true">Verificando modo…</button>
            : <button className={mode === 'dry' ? 'mode-pill dry-pill' : 'mode-pill real-pill'} title={mode === 'dry' ? 'Cambiar a modo real (pide confirmación)' : 'Volver a Dry Run'} onClick={() => void toggleDryRun()}>{mode === 'dry' ? 'Dry Run · Activo' : 'Modo real · Activo'}</button>}
        </div>
      </header>
      <div className={`mode-banner ${mode}`}>
        {mode === 'checking' && <span>Verificando el modo de envío…</span>}
        {mode === 'dry' && <span><strong>Modo prueba:</strong> la app analiza y simula, no envía mensajes reales</span>}
        {mode === 'real' && <span><strong>Modo real:</strong> se enviarán mensajes privados reales en automatizaciones autorizadas</span>}
      </div>
      {loading && <div className="loading-line">Actualizando datos locales…</div>}
      <div className="content">
        {section === 'dashboard' && <DashboardView data={dashboard} accounts={accounts} connections={connections} automations={automations} accountFilter={accountFilter} accountCount={allAccounts.length} accountLabel={accountLabel} onNavigate={setSection} onRefresh={() => void refresh()} />}
        {section === 'connections' && <ConnectionsView connections={connections} accounts={accounts} candidates={candidates} setCandidates={setCandidates} api={api} act={act} confirm={confirm} features={features} />}
        {section === 'media' && <MediaView accounts={accounts} allAccounts={allAccounts} onSelectAccount={chooseAccount} media={media} selected={accountFilter} onNavigate={setSection} api={api} act={act} />}
        {section === 'automations' && <AutomationView accounts={accounts} media={media} rows={automations} selected={accountFilter} api={api} act={act} confirm={confirm} />}
        {section === 'monitor' && <MonitorView accounts={accounts} status={dashboard?.monitoringEnabled ?? false} onNavigate={setSection} api={api} act={act} />}
        {section === 'backlog' && <BacklogView allAccounts={allAccounts} accounts={accounts} onSelectAccount={chooseAccount} selected={accountFilter} job={scanJob} setJob={setScanJob} rows={automations} api={api} act={act} confirm={confirm} />}
        {section === 'queue' && <QueueView items={queue} total={queueTotal} offset={queueOffset} setOffset={setQueueOffset} state={queueState} setState={(value) => { setQueueOffset(0); setQueueState(value); }} onNavigate={setSection} api={api} act={act} />}
        {section === 'settings' && <SettingsView mode={mode} act={act} api={api} confirm={confirm} features={features} />}
      </div>
      <footer className="footer-note"><span>Datos y credenciales permanecen en el servidor local.</span><button onClick={() => void refresh()}>Actualizar</button></footer>
    </section>
    <div className="toast-region">
      <div role="alert" aria-live="assertive" aria-atomic="true">{error && <div className="toast error"><div><strong>La acción no se completó</strong><span>{safeErrorLabel(error)}</span></div><button onClick={() => setError('')} aria-label="Cerrar aviso de error">×</button></div>}</div>
      <div role="status" aria-live="polite" aria-atomic="true">{notice && <div className="toast success"><div><span>{notice}</span></div><button onClick={() => setNotice('')} aria-label="Cerrar aviso">×</button></div>}</div>
    </div>
    {dialog && <ConfirmDialog options={dialog} onResult={settleDialog} />}
  </main>;
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
      <button type="button" className="button secondary" data-autofocus={options.danger ? '' : undefined} onClick={() => onResult(false)}>Cancelar</button>
      <button type="button" className={options.danger ? 'button danger-solid' : 'button primary'} data-autofocus={options.danger ? undefined : ''} onClick={() => onResult(true)}>{options.confirmLabel}</button>
    </div>
  </Modal>;
}

/* ---------- Views ---------- */

function DashboardView({ data, accounts, connections, automations, accountFilter, accountCount, accountLabel, onNavigate, onRefresh }: { data: Dashboard | null; accounts: Account[]; connections: Connection[]; automations: Automation[]; accountFilter: string; accountCount: number; accountLabel: string; onNavigate(id: string): void; onRefresh(): void }) {
  if (!data) return <Empty title="Cargando datos locales…" detail="Si este mensaje no desaparece, revise que la aplicación local siga en ejecución." />;
  const total = (states: string[]) => data.queue.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.count, 0);
  const onboarding = deriveOnboarding({ connections, accounts, automations, monitoringEnabled: data.monitoringEnabled });
  return <>
    <div className="welcome-row"><div><p className="eyebrow">VISTA GENERAL · {accountLabel.toUpperCase()}</p><h2>Estado operativo</h2><p className="muted">Resumen basado en la información guardada en esta instalación.</p></div><button className="button secondary" onClick={onRefresh}>Actualizar datos</button></div>
    {shouldShowOnboarding({ allDone: onboarding.allDone, filter: accountFilter, accountCount }) && <section className="panel onboarding" aria-labelledby="onboarding-title">
      <div className="panel-heading"><div><h3 id="onboarding-title">Primeros pasos</h3><p className="muted">Cuatro pasos para empezar. Mientras Dry Run esté activo, nada se envía de verdad.</p></div><span className="count-badge">{onboarding.steps.filter((step) => step.state === 'done').length} de {onboarding.steps.length} listos</span></div>
      <ol className="steps">{onboarding.steps.map((step, index) => <li key={step.id} className={`step ${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
        <span className="step-mark" aria-hidden="true">{step.state === 'done' ? '✓' : index + 1}</span>
        <div className="step-text"><strong>{step.label}<span className="visually-hidden"> — {step.state === 'done' ? 'listo' : step.state === 'current' ? 'siguiente paso' : 'pendiente'}</span></strong><span className="muted">{step.detail}</span></div>
        <button className={step.state === 'current' ? 'button primary' : 'button secondary'} onClick={() => onNavigate(step.target)}>{step.state === 'done' ? 'Revisar' : step.actionLabel}</button>
      </li>)}</ol>
    </section>}
    <div className="metric-grid"><Metric label="Cuentas" value={accounts.length} note="Cuentas seleccionadas" /><Metric label="En cola" value={total(['QUEUED', 'FAILED_RETRYABLE'])} note="Pendientes de procesamiento" /><Metric label="Enviadas" value={total(['SENT'])} note="Confirmadas por API" /><Metric label="Revisión" value={total(['UNKNOWN_OUTCOME', 'FAILED_PERMANENT'])} note="Requieren atención" /><Metric label="Expirados" value={total(['EXPIRED'])} note="Superaron la ventana de 7 días" /></div>
    <div className="panel"><div className="panel-heading"><div><h3>Estado por cuenta</h3><p className="muted">Sincronización, cobertura y monitoreo</p></div><button className="text-button" onClick={() => onNavigate('monitor')}>Abrir monitoreo →</button></div>
      {!accounts.length ? <Empty title="No hay cuentas conectadas" detail="Añada una conexión y seleccione una cuenta descubierta." action={() => onNavigate('connections')} actionLabel="Configurar conexión" /> : <div className="table-wrap"><table><thead><tr><th>Cuenta</th><th>Estado</th><th>Última sincronización</th><th>Cobertura</th><th>Incidencia</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.accountId}><td><strong>@{account.username}</strong></td><td>{account.monitoringPaused ? <Status value="Pausado" tone="neutral" /> : account.status === 'valid' ? <Status value="Validada" tone="good" /> : <Status value="No validada" tone="warn" />}</td><td>{account.last_sync ? formatDate(account.last_sync) : 'Sin sincronización'}</td><td>{account.coverage ?? 'Sin datos'}</td><td>{account.last_error ?? '—'}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="quick-actions"><button className="action-card" onClick={() => onNavigate('connections')}><strong>Administrar conexiones</strong><span>Validar credenciales y cuentas</span></button><button className="action-card" onClick={() => onNavigate('automations')}><strong>Configurar automatizaciones</strong><span>Elegir publicación y palabras clave</span></button><button className="action-card" onClick={() => onNavigate('backlog')}><strong>Revisar comentarios</strong><span>Analizar una ventana sin enviar</span></button></div>
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
  return <div className="split-layout"><div className="stack">
    <div className="panel"><div className="panel-heading"><div><h3>Conexiones Meta</h3><p className="muted">Los tokens se cifran en el servidor y nunca se vuelven a mostrar.</p></div></div>
      {!connections.length ? <Empty title="Aún no hay conexiones" detail="Guarde un token de Meta con el formulario «Nueva conexión»; después valídelo para descubrir sus cuentas." action={() => focusById('conn-name')} actionLabel="Crear la primera conexión" primary /> : connections.map((connection) => <div className="list-row" key={connection.id}><div><strong>{connection.name}</strong><span className="muted">{connection.login_kind === 'instagram_login' ? 'Instagram Login' : 'Facebook Login'} · {connection.graph_version}</span><span><ConnectionBadge status={connection.status} /></span></div><div className="row-actions"><button className="button primary small" onClick={() => void discover(connection.id)}>Probar y descubrir</button><button className="button secondary small" onClick={() => { setEditing(connection); setEditName(connection.name); setEditAppId(connection.app_id ?? ''); setEditVersion(connection.graph_version); setEditToken(''); }}>Editar</button><button className="button danger small" onClick={() => void disconnect(connection)}>Desconectar</button><button className="button danger small" onClick={() => void remove(connection)}>Eliminar</button></div></div>)}
    </div>
    <form className="panel form-panel" onSubmit={(event) => void create(event)}><div><h3>Nueva conexión</h3><p className="muted">Use un token con acceso autorizado a la cuenta que desea administrar.</p></div>
      <div className="form-grid"><Field label="Nombre"><input id="conn-name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Cuenta principal" /></Field><Field label="Tipo de acceso"><select value={loginKind} onChange={(event) => setLoginKind(event.target.value)}><option value="instagram_login">Instagram Login · token de Instagram</option><option value="facebook_login">Facebook Login · token de usuario y página vinculada</option></select></Field><Field label="App ID (opcional)"><input value={appId} onChange={(event) => setAppId(event.target.value)} /></Field><Field label="Versión Graph"><input required pattern="v[0-9]+\.[0-9]+" value={version} onChange={(event) => setVersion(event.target.value)} /></Field><Field label="Token de acceso · solo captura"><input required type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} /></Field></div>
      <div><button className="button primary" type="submit">Guardar conexión cifrada</button></div>
    </form>
    {editing && <form className="panel form-panel" onSubmit={(event) => void update(event)}><div><h3>Editar conexión</h3><p className="muted">Deje el token vacío para conservarlo. Si cambia, se invalida la validación anterior.</p></div><div className="form-grid"><Field label="Nombre"><input required value={editName} onChange={(event) => setEditName(event.target.value)} /></Field><Field label="App ID"><input value={editAppId} onChange={(event) => setEditAppId(event.target.value)} /></Field><Field label="Versión Graph"><input required pattern="v[0-9]+\.[0-9]+" value={editVersion} onChange={(event) => setEditVersion(event.target.value)} /></Field><Field label="Nuevo token · captura opcional"><input type="password" autoComplete="new-password" value={editToken} onChange={(event) => setEditToken(event.target.value)} /></Field></div><div className="row-actions"><button className="button primary">Guardar cambios</button><button type="button" className="button secondary" onClick={() => { setEditToken(''); setEditing(null); }}>Cancelar</button></div></form>}
  </div><div className="stack"><div className="panel"><div className="panel-heading"><div><h3>Cuentas seleccionadas</h3><p className="muted">Los ID se obtienen de la respuesta oficial de Meta.</p></div></div>{accounts.length ? accounts.map((account) => <div className="list-row" key={account.accountId}><div><strong>@{account.username}</strong><span className="muted">{account.status === 'valid' ? 'Validada' : account.status} · {account.accountId}</span></div></div>) : <p className="empty-inline">Aún no hay cuentas seleccionadas. Pruebe una conexión y pulse «Seleccionar» en la cuenta que desea usar.</p>}</div>
    <div className="panel"><h3>Cuentas descubiertas</h3>{candidates.length ? candidates.map((candidate) => <div className="list-row" key={candidate.providerAccountId}><div><strong>@{candidate.username}</strong><span className="muted">ID de proveedor: {candidate.providerAccountId}</span></div><button className="button primary small" onClick={() => void act(() => api(`/api/connections/${candidate.connectionId}/select`, 'POST', { account: candidate }), 'Cuenta vinculada con su historial.')}>Seleccionar</button></div>) : <p className="empty-inline">Pulse «Probar y descubrir» en una conexión para listar las cuentas disponibles.</p>}</div>
    {legacyAccounts.length > 0 && <div className="panel"><h3>Retención heredada</h3><p className="muted">{features.legacyInterlock ? 'Una cuenta usada antes con otra herramienta puede tener un bloqueo o historial de rechazos previos. La aplicación nunca borra ni modifica esos archivos.' : 'Esta cuenta conserva una retención de una configuración heredada anterior. Revísela y reconózcala para liberarla.'}</p>{legacyAccounts.map((account) => <div className="list-row" key={`legacy-${account.accountId}`}><strong>@{account.username}</strong><button className="button secondary small" onClick={() => void acknowledgeLegacy(account)}>Revisar estado y reconocer</button></div>)}</div>}</div></div>;
}

function MediaView({ accounts, allAccounts, onSelectAccount, media, selected, onNavigate, api, act }: { accounts: Account[]; allAccounts: Account[]; onSelectAccount(id: string): void; media: Media[]; selected: string; onNavigate(id: string): void; api: Api; act: Act }) {
  const current = selected === 'all' ? '' : selected;
  const own = media.filter((item) => item.accountId === current);
  const choices = allAccounts.length ? allAccounts : accounts;
  const reload = () => void act(() => api(`/api/connections/${choices.find((item) => item.accountId === current)?.connectionId}/media`, 'POST', { accountId: current }), 'Publicaciones actualizadas.');
  return <div className="panel"><div className="panel-heading"><div><h3>Publicaciones de la cuenta</h3><p className="muted">Elija una cuenta para cargar sus publicaciones autorizadas.</p></div>{current && <button className="button secondary" onClick={reload}>Actualizar publicaciones</button>}</div>
    {current ? own.length ? <div className="media-grid">{own.map((item) => { const type = mediaTypeLabel(item.mediaType); const caption = shortCaption(item.caption, 80); return <article className="media-card" key={item.mediaId}><span className="media-icon" aria-hidden="true">▧</span><div>{type && <span className="type-badge">{type}</span>}<strong className={caption ? 'media-caption' : 'media-caption muted-text'}>{caption ?? `Sin texto · ${shortId(item.mediaId)}`}</strong><span>{item.publishedAt ? formatDate(item.publishedAt) : 'Fecha no disponible'}</span>{item.permalink && <a href={item.permalink} target="_blank" rel="noreferrer">Ver comentarios ↗</a>}</div></article>; })}</div>
      : <Empty title="Sin publicaciones guardadas" detail="Descargue las publicaciones de esta cuenta para poder crear automatizaciones." action={reload} actionLabel="Actualizar publicaciones" primary />
      : choices.length ? <div className="account-prompt" role="group" aria-labelledby="media-account-prompt"><strong id="media-account-prompt">Elija una cuenta para ver sus publicaciones</strong><p className="muted">Las publicaciones se cargan de una cuenta a la vez.</p><div className="row-actions">{choices.map((account) => <button key={account.accountId} className="button secondary" onClick={() => onSelectAccount(account.accountId)}>@{account.username}</button>)}</div></div>
        : <Empty title="Aún no hay cuentas" detail="Conecte Meta y elija una cuenta antes de ver sus publicaciones." action={() => onNavigate('connections')} actionLabel="Ir a Conexiones" primary />}</div>;
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
  return <div className="split-layout"><form className="panel form-panel" onSubmit={(event) => void create(event)}><div><h3>Nueva automatización</h3><p className="muted">Seleccione primero la cuenta; las publicaciones pertenecen a esa cuenta.</p></div><div className="form-grid"><Field label="Cuenta"><select id="auto-account" required value={accountId} onChange={(event) => { setAccountId(event.target.value); setMediaId(''); }}><option value="">Seleccione una cuenta</option>{accounts.map((account) => <option key={account.accountId} value={account.accountId}>@{account.username}</option>)}</select></Field><Field label="Publicación"><select required disabled={!accountId} value={mediaId} onChange={(event) => setMediaId(event.target.value)}><option value="">Seleccione una publicación</option><option value={GENERAL_MEDIA_OPTION}>Todas las publicaciones (general)</option>{ownMedia.map((item) => <option key={item.mediaId} value={item.mediaId}>{mediaLabel(item)}</option>)}</select>{mediaId === GENERAL_MEDIA_OPTION && <small className="hint">Se aplica a cualquier publicación de la cuenta que no tenga su propia automatización; solo comentarios posteriores a la activación.</small>}</Field><Field label="Nombre"><input required value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Palabras clave · separadas por coma"><input required value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="guia, ebook" /></Field><Field label="Coincidencia"><select value={mode} onChange={(event) => setMode(event.target.value)}><option value="contains">Frase dentro del comentario</option><option value="exact">Comentario exacto</option></select></Field><Field label="Respuesta · variables {{username}}, {{comment}}, {{keyword}}"><textarea required rows={4} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></Field><Field label="Botón URL opcional · título"><input maxLength={20} value={buttonTitle} onChange={(event) => setButtonTitle(event.target.value)} placeholder="Ver recurso" /></Field><Field label="URL HTTPS"><input type="url" value={buttonUrl} onChange={(event) => setButtonUrl(event.target.value)} placeholder="https://…" /></Field><Field label="Segundo botón · título opcional"><input maxLength={20} value={buttonTitle2} onChange={(event) => setButtonTitle2(event.target.value)} /></Field><Field label="Segundo botón · URL HTTPS"><input type="url" value={buttonUrl2} onChange={(event) => setButtonUrl2(event.target.value)} /></Field></div><p className="hint">{MEDIA_LINK_TIP}</p><PublicReplyFields idPrefix="new" enabled={publicEnabled} setEnabled={setPublicEnabled} text={publicVariants} setText={setPublicVariants} /><p className="hint">Puede añadir cero, uno o dos botones URL en esta pantalla. Las palabras clave son sinónimos: si varias aparecen en un mismo comentario, se procesa una sola coincidencia.</p><div><button className="button primary" disabled={!accountId || !mediaId}>Guardar automatización</button></div></form>
    <div className="panel"><h3>Automatizaciones</h3>{rows.length ? rows.map((row) => <article className="automation-row" key={row.automationId}><div className="row-between"><div><strong>{row.name}</strong><span className="muted">{accounts.find((item) => item.accountId === row.accountId)?.username ? `@${accounts.find((item) => item.accountId === row.accountId)?.username}` : 'Cuenta'} · {automationTargetLabel(row, media)}</span><span className="keyword-list">{row.keywords.map((keyword) => keyword.phrase).join(' · ') || 'Sin palabras clave'}</span></div><div className="badge-col">{row.scope === 'account' && <Status value="General" tone="neutral" />}<Status value={row.status === 'enabled' ? 'Activa' : 'Pausada'} tone={row.status === 'enabled' ? 'good' : 'neutral'} /><Status value={row.realEnabled ? 'Real autorizado' : 'Solo prueba'} tone={row.realEnabled ? 'warn' : 'neutral'} />{row.publicReplyEnabled && <Status value={`Respuesta pública · ${variantCountLabel(row.publicReplyVariants?.length ?? 0)}`} tone="neutral" />}</div></div><div className="row-actions"><button className="button secondary small" onClick={() => void act(() => api(`/api/automations/${row.automationId}/enabled`, 'PATCH', { accountId: row.accountId, enabled: row.status !== 'enabled' }), row.status === 'enabled' ? 'Automatización pausada.' : 'Automatización activada con corte desde ahora.')}>{row.status === 'enabled' ? 'Pausar' : 'Activar'}</button><button className="button secondary small" onClick={() => setEditing(row)}>Editar</button><button className={row.realEnabled ? 'button secondary small' : 'button danger small'} onClick={() => void toggleReal(row)}>{row.realEnabled ? 'Quitar permiso real' : 'Autorizar real'}</button><button className="button danger small" onClick={() => void archive(row)}>Archivar</button></div></article>) : <Empty title="Aún no hay automatizaciones" detail="Cree una automatización asociada a una de sus publicaciones. Empieza en modo prueba." action={() => focusById('auto-account')} actionLabel="Crear la primera automatización" primary />}</div>
    {editing && <AutomationEditDialog row={editing} mediaOptions={media.filter((item) => item.accountId === editing.accountId).map((item) => ({ id: item.mediaId, label: mediaLabel(item) }))} onClose={() => setEditing(null)} onSave={async (values) => {
      const saved = await act(() => api(`/api/automations/${editing.automationId}`, 'PUT', { accountId: editing.accountId, mediaId: editing.scope === 'account' ? null : values.mediaId, name: values.name, replyText: values.replyText, matchMode: values.matchMode, buttons: editing.buttons ?? [], keywords: values.keywords.split(',').map((keyword) => keyword.trim()).filter(Boolean), publicReplyEnabled: values.publicReplyEnabled, publicReplyVariants: parseVariantLines(values.publicReplyVariants) }), 'Automatización actualizada; se invalidaron elementos con plantilla anterior.');
      if (saved) setEditing(null);
    }} />}
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
        <Field label="Palabras clave sinónimas · separadas por coma"><input required value={keywords} onChange={(event) => setKeywords(event.target.value)} /></Field>
        <Field label="Coincidencia"><select value={matchMode} onChange={(event) => setMatchMode(event.target.value)}><option value="contains">Frase dentro del comentario (contains)</option><option value="exact">Comentario exacto (exact)</option></select></Field>
        <Field label="Plantilla de respuesta · variables {{username}}, {{comment}}, {{keyword}}"><textarea required rows={4} value={replyText} onChange={(event) => setReplyText(event.target.value)} /></Field>
      </div>
      <PublicReplyFields idPrefix="edit" enabled={publicEnabled} setEnabled={setPublicEnabled} text={publicVariants} setText={setPublicVariants} />
      <datalist id="edit-media-options">{mediaOptions.map((option) => <option key={option.id} value={option.id} label={option.label} />)}</datalist>
      {problem && <p className="form-problem" role="alert">{problem}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
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
    <label className="check-row" htmlFor={`${idPrefix}-public-enabled`}><input id={`${idPrefix}-public-enabled`} type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Responder también públicamente al comentario</label>
    {enabled && <>
      <Field label="Variantes de la respuesta pública (una por línea)"><textarea id={`${idPrefix}-public-variants`} required rows={5} value={text} onChange={(event) => setText(event.target.value)} placeholder={'¡Listo @{{username}}! Te escribí por mensaje privado\nRevisa tu bandeja de entrada, @{{username}}'} aria-describedby={`${idPrefix}-public-hint`} /></Field>
      <div className="row-between"><span className="count-badge" aria-live="polite">{variantCountLabel(variants.length)}</span>{examples.length > 0 && <button type="button" className="text-button" onClick={() => setSeed((value) => value + 1)}>Otros ejemplos</button>}</div>
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
    <button className="button secondary" disabled={busy} onClick={() => void inspect()}>{busy ? 'Inspeccionando…' : 'Inspeccionar conversación (experimental)'}</button>
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
  return <div className="panel"><div className="panel-heading"><div><h3>Monitoreo</h3><p className="muted">El monitoreo siempre inicia apagado al reiniciar la aplicación.</p></div><Status value={status ? 'Activo' : 'Detenido'} tone={status ? 'good' : 'neutral'} /></div><div className="row-actions"><button className="button primary" onClick={() => void act(() => api('/api/monitor/all', 'POST', { action: 'start' }), 'Monitoreo iniciado para cuentas validadas.')}>Iniciar todas</button><button className="button secondary" onClick={() => void act(() => api('/api/monitor/all', 'POST', { action: 'stop' }), 'Todo el monitoreo se detuvo.')}>Detener todas</button></div>{accounts.length ? <div className="table-wrap"><table><thead><tr><th>Cuenta</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.accountId}><td>@{account.username}</td><td>{account.monitoringPaused ? <Status value="Pausado" tone="neutral" /> : <Status value="En monitoreo" tone="good" />}</td><td><button className="button secondary small" onClick={() => void act(() => api(`/api/monitor/${account.accountId}`, 'POST', { action: account.monitoringPaused ? 'start' : 'stop' }), account.monitoringPaused ? 'Cuenta en monitoreo.' : 'Monitoreo pausado.')}>{account.monitoringPaused ? 'Reanudar' : 'Detener'}</button></td></tr>)}</tbody></table></div> : <Empty title="Sin cuentas disponibles" detail="Valide y seleccione una cuenta antes de iniciar el monitoreo." action={() => onNavigate('connections')} actionLabel="Ir a Conexiones" primary />}</div>;
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
  return <div className="panel"><div className="panel-heading"><div><h3>Analizar comentarios</h3><p className="muted">El análisis solo clasifica; no añade mensajes a la cola ni los envía.</p></div></div><div className="form-grid compact"><Field label="Ventana"><select value={windowValue} onChange={(event) => setWindow(event.target.value)}>{['2h', '24h', '3d', '7d', 'custom'].map((value) => <option key={value} value={value}>{WINDOW_LABELS[value]}</option>)}</select></Field>{windowValue === 'custom' && <Field label="Desde"><input type="datetime-local" value={customSince} onChange={(event) => setCustomSince(event.target.value)} /></Field>}</div><div className="row-actions"><button id="backlog-start" className="button primary" disabled={!!job && job.status === 'running'} onClick={() => void act(async () => { const result = await api('/api/backlog/jobs', 'POST', { accountId: selected, window: windowValue, ...(customSince ? { customSince: new Date(customSince).toISOString() } : {}) }); setJob({ id: result.jobId, status: 'running', createdAt: new Date().toISOString() }); }, 'Análisis iniciado; puede continuar usando otras secciones.')}>Iniciar análisis</button>{job?.status === 'running' && <button className="button secondary" disabled={cancelling} onClick={() => { setCancelling(true); void api(`/api/backlog/jobs/${job.id}/cancel`, 'POST', {}).catch(() => setCancelling(false)); }}>{cancelling ? 'Cancelando…' : 'Cancelar'}</button>}</div>
    {!job && <p className="hint spaced">Sin análisis en esta sesión. Elija una ventana de tiempo e inicie el análisis para ver qué comentarios habrían coincidido.</p>}
    {job && <div className="job-status">Análisis: {job.status === 'running' ? <Status value="En curso" tone="neutral" /> : job.status === 'complete' ? <Status value="Finalizado" tone="good" /> : job.status === 'partial' ? <Status value="Cobertura parcial" tone="warn" /> : job.status === 'cancelled' ? <Status value="Cancelado" tone="neutral" /> : <Status value="Error" tone="danger" />} <span>{job.status === 'partial' ? 'Una o más cuentas tuvieron cobertura incompleta.' : 'El análisis no envía mensajes.'}</span></div>}
    {job && running && <ScanProgressPanel progress={job.progress} elapsedMs={tick - Date.parse(job.createdAt ?? '') || 0} />}
    {job && !running && <ScanSummaryCard status={job.status} summary={summary} />}
    <div className="pending-review">
      <div className="panel-heading"><div><h3>Comentarios pendientes de revisión</h3><p className="muted">Resultados del último análisis completo; se conservan al recargar. Ya en cola o con más de 7 días no aparecen.</p></div>{pending && <span className="count-badge">{pending.total} pendientes</span>}</div>
      {!processAccount ? (choices.length ? <div className="account-prompt" role="group" aria-labelledby="backlog-account-prompt"><strong id="backlog-account-prompt">Elija una cuenta para ver sus comentarios pendientes</strong><p className="muted">La revisión se hace de una cuenta a la vez.</p><div className="row-actions">{choices.map((account) => <button key={account.accountId} className="button secondary" onClick={() => onSelectAccount(account.accountId)}>@{account.username}</button>)}</div></div> : <p className="hint">Aún no hay cuentas disponibles.</p>)
        : pendingError ? <p className="form-problem" role="alert">No se pudieron cargar los comentarios pendientes. <button className="text-button" onClick={() => void loadPending()}>Reintentar</button></p>
        : !pending ? <p className="hint">Cargando comentarios pendientes…</p>
        : <>
          <p className="muted" role="status">{pending.lastAnalyzedAt ? `Última revisión: ${formatDate(pending.lastAnalyzedAt)}` : 'Esta cuenta aún no tiene un análisis completo.'} · {pending.total} {pending.total === 1 ? 'comentario pendiente' : 'comentarios pendientes'}</p>
          {items.length > 0 ? <>
            <div className="table-wrap"><table><thead><tr><th>Seleccionar</th><th>Usuario</th><th>Comentario</th><th>Fecha</th><th>Automatización · publicación</th><th>Palabra clave</th><th>Vista previa del mensaje</th></tr></thead><tbody>{items.map((item) => <tr key={`${item.commentId}-${item.automationId}`}>
              <td><input type="checkbox" aria-label={`Seleccionar comentario de @${item.username || 'usuario'}: ${item.commentText.slice(0, 40)}`} disabled={!eligibleForChoice(item)} checked={selectedIds.includes(item.commentId)} onChange={(event) => setSelectedIds(event.target.checked ? [...selectedIds, item.commentId] : selectedIds.filter((id) => id !== item.commentId))} /></td>
              <td>{item.username ? `@${item.username}` : '—'}</td><td className="comment-cell" title={item.commentText}>{item.commentText || '—'}</td><td>{item.commentCreatedAt ? formatDate(item.commentCreatedAt) : '—'}</td><td>{item.automationName}{item.scope === 'account' && <> <Status value="General" tone="neutral" /></>}<small className="muted cell-sub">{mediaLabel({ mediaId: item.mediaId, caption: item.mediaCaption, mediaType: item.mediaType, publishedAt: item.mediaPublishedAt })}</small></td><td>{item.matchedKeywords.join(', ') || '—'}</td>
              <td>{item.previewText ? <details className="message-preview"><summary>Ver mensaje</summary><div className="preview-box"><p>{item.previewText}</p>{item.previewButtons.length > 0 && <ul>{item.previewButtons.map((button) => <li key={button.url}>Botón «{button.title}» → {button.url}</li>)}</ul>}<small className="muted">Vista previa; nada se envía hasta procesar.</small></div></details> : <span className="muted">Sin vista previa</span>}</td>
            </tr>)}</tbody></table></div>
            {pending.total > PENDING_PAGE && <div className="pagination"><button className="button secondary" disabled={pendingOffset <= 0} onClick={() => setPendingOffset(Math.max(0, pendingOffset - PENDING_PAGE))}>Anterior</button><span>{pendingOffset + 1}–{pendingOffset + items.length} de {pending.total}</span><button className="button secondary" disabled={pendingOffset + items.length >= pending.total} onClick={() => setPendingOffset(pendingOffset + PENDING_PAGE)}>Siguiente</button></div>}
            <div className="form-grid compact"><Field label="Cuenta"><input readOnly value={`@${accounts.find((item) => item.accountId === processAccount)?.username ?? choices.find((item) => item.accountId === processAccount)?.username ?? ''}`} /></Field><Field label="Procesar con automatización"><select value={automationId} onChange={(event) => { setAutomationId(event.target.value); setSelectedIds([]); }}><option value="">Seleccione</option>{rows.filter((row) => row.status === 'enabled' && row.accountId === processAccount).map((row) => <option key={row.automationId} value={row.automationId}>{row.name}</option>)}</select></Field><button className="button secondary" disabled={!automationId} onClick={() => setSelectedIds(items.filter((item) => item.automationId === automationId).map((item) => item.commentId))}>Seleccionar todos los visibles</button><button className="button primary" disabled={!selectedIds.length || !automationId || !processAccount} onClick={() => void processSelection()}>Procesar selección revisada</button></div>
          </> : <Empty title="No hay comentarios pendientes" detail="Analice los comentarios de esta cuenta para encontrar los que coinciden con una automatización." action={() => focusById('backlog-start')} actionLabel="Analizar comentarios" primary />}
        </>}
    </div></div>;
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
  return <div className="panel">
    <div className="panel-heading">
      <div><h3>Cola e historial</h3><p className="muted">Los resultados ambiguos nunca son reintentables automáticamente.</p></div>
      <span className="count-badge">{total} registros</span>
    </div>
    <label className="field queue-filter">Filtrar por estado
      <select value={state} onChange={(event) => setState(event.target.value)}>
        <option value="all">Todos los estados</option>
        {['SIMULATED', 'QUEUED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'UNKNOWN_OUTCOME', 'SENT', 'EXPIRED', 'SKIPPED'].map((value) => <option key={value} value={value}>{stateLabel(value)}</option>)}
      </select>
    </label>
    {detailError && <p className="form-problem" role="alert">No se pudieron cargar los detalles del intento.</p>}
    {items.length ? <>
      <div className="table-wrap"><table>
        <thead><tr><th>Cuenta</th><th>Autor</th><th>Comentario</th><th>Estado</th><th>Intentos</th><th>ID de mensaje</th><th>Código seguro</th><th>Fecha</th><th>Historial</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td>@{item.username}</td><td>{item.commentUsername ? `@${item.commentUsername}` : '—'}</td><td className="comment-cell" title={item.commentText || item.commentId}>{item.commentText || item.commentId}</td><td><Status value={stateLabel(item.state)} tone={queueTone(item.state)} />{item.state === 'UNKNOWN_OUTCOME' && <small className="state-hint">Revise manualmente en Instagram; nunca se reintenta.</small>}</td>
          <td>{item.attemptCount}</td><td>{item.messageId ?? '—'}</td><td>{item.safeErrorCode ?? '—'}</td>
          <td>{formatDate(item.createdAt)}</td><td><button className="text-button" onClick={() => void showAttempts(item)}>{expanded === item.id ? 'Ocultar' : 'Ver'}</button></td>
        </tr>).flatMap((row, index) => {
          const item = items[index]!;
          return expanded === item.id ? [row, <tr key={`${item.id}-events`}><td colSpan={9}>{(() => { const message = describeQueuePayload(item); return <div className="queue-message"><strong>{message.label}</strong>{message.text ? <p className="preview-box">{message.text}</p> : <p className="muted">Sin texto de mensaje guardado.</p>}{message.buttons.length > 0 && <ul>{message.buttons.map((button) => <li key={button.url}>Botón «{button.title}» → {button.url}</li>)}</ul>}</div>; })()}<FollowGateDetail item={item} events={gateEvents} />{(() => { const reply = describePublicReply(item); if (!reply) return null; return <div className="queue-message public-reply-detail"><strong>{reply.label}</strong>{reply.text ? <p className="preview-box">{reply.text}</p> : <p className="muted">Sin texto guardado.</p>}{reply.hint && <small className="state-hint">{reply.hint}</small>}{item.publicReply?.safeErrorCode && !publicReplyErrorHint(item.publicReply.safeErrorCode) && <small className="muted">Código: {item.publicReply.safeErrorCode}</small>}{reply.canRetry && <div><button className="button secondary small" onClick={() => void retryPublic(item)}>Reintentar respuesta pública</button></div>}{publicEvents.length > 0 && <div className="attempt-list">{publicEvents.map((event, eventIndex) => <div key={`public-${event.at}-${eventIndex}`}><strong>público · {event.type}</strong><span>{formatDate(event.at)}</span><span>{event.replyId ?? event.safeErrorCode ?? 'Sin detalle adicional'}</span></div>)}</div>}</div>; })()}{item.state === 'SENT' && <div className="readback-check">
            <button className="button secondary" disabled={verifying} onClick={() => void verifyReadback(item)}>{verifying ? 'Verificando…' : 'Verificar lectura'}</button>
            {verifyResult?.itemId === item.id && <span role="status">{verifyResult.text}</span>}
          </div>}{item.state === 'SENT' && <ConversationInspector key={`inspect-${item.id}`} item={item} api={api} />}<div className="attempt-list">
            {events.length ? events.map((event, eventIndex) => <div key={`${event.at}-${eventIndex}`}><strong>{event.type}</strong><span>{formatDate(event.at)}</span><span>{event.type === 'readback' ? readbackSummary(event) : (event.messageId ?? event.safeErrorCode ?? 'Sin detalle adicional')}</span></div>) : <span>{item.state === 'SIMULATED' ? 'Sin intentos: simulado, nada se envió.' : 'Sin intentos registrados.'}</span>}
          </div></td></tr>] : [row];
        })}</tbody>
      </table></div>
      <div className="pagination"><button className="button secondary" disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Anterior</button><span>{offset + 1}–{Math.min(offset + items.length, total)} de {total}</span><button className="button secondary" disabled={offset + items.length >= total} onClick={() => setOffset(offset + 50)}>Siguiente</button></div>
    </> : <Empty title={state === 'all' ? 'La cola está vacía' : 'No hay registros con este estado'} detail={state === 'all' ? 'Los comentarios nuevos y los seleccionados manualmente aparecerán aquí.' : 'Pruebe con otro estado o con «Todos los estados».'} action={state === 'all' ? () => onNavigate('backlog') : () => setState('all')} actionLabel={state === 'all' ? 'Revisar comentarios pendientes' : 'Ver todos los estados'} primary />}
  </div>;
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
  return <div className="panel"><div className="panel-heading"><div><h3>Seguridad y configuración</h3><p className="muted">La aplicación se ejecuta solo en este equipo; el monitoreo no se reactiva al reiniciar.</p></div></div>
    <div className="settings-row"><div><strong>Modo de envío</strong><span className="muted">{mode === 'checking' ? 'Verificando el modo de envío…' : mode === 'dry' ? 'Dry Run activo: no se envían respuestas.' : 'Modo real activo; requiere automatizaciones autorizadas.'}</span></div>{mode === 'checking' ? <Status value="Verificando…" tone="neutral" /> : mode === 'dry' ? <Status value="Dry Run" tone="good" /> : <Status value="Modo real" tone="warn" />}</div>
    <div className="settings-row"><div><strong>Importar configuración existente</strong><span className="muted">{features.envImport ? 'Lee únicamente variables permitidas del archivo .env configurado y cifra el token como una conexión nueva. No modifica el archivo ni muestra el secreto.' : ENV_IMPORT_DISABLED_HINT}</span></div>{features.envImport ? <button className="button secondary" onClick={() => void importEnv()}>Importar .env del proyecto</button> : <Status value="Desactivada" tone="neutral" />}</div>
    <div className="settings-row"><div><strong>Protección de cuenta heredada</strong><span className="muted">{features.legacyInterlock ? 'Los bloqueos previos se verifican antes de cualquier modo real. La aplicación nunca elimina bloqueos ni contadores externos.' : 'Desactivada: no se lee ninguna carpeta de otra herramienta. Se activa con SOCIAL_DESK_LEGACY_ACCOUNTS_DIR o SOCIAL_DESK_LEGACY_HOLD_USERNAMES.'}</span></div>{features.legacyInterlock ? <Status value="Interlock local activo" tone="good" /> : <Status value="No configurada" tone="neutral" />}</div>
  </div>;
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
const TONE_ICON: Record<Tone, string> = { good: '✓', neutral: '•', warn: '!', danger: '✕' };
/** Color is never the only signal: each tone also has a glyph and always carries text. */
function Status({ value, tone }: { value: string; tone: Tone }) { return <span className={`status-badge ${tone}`}><span aria-hidden="true">{TONE_ICON[tone]}</span>{value}</span>; }
function ConnectionBadge({ status }: { status: string }) {
  if (status === 'valid') return <Status value="Validada" tone="good" />;
  if (status === 'unvalidated') return <Status value="Sin validar" tone="neutral" />;
  if (status === 'invalid') return <Status value="Token inválido" tone="danger" />;
  if (status === 'disconnected') return <Status value="Desconectada" tone="neutral" />;
  return <Status value={status} tone="warn" />;
}
function Empty({ title, detail, action, actionLabel, primary }: { title: string; detail: string; action?: () => void; actionLabel?: string; primary?: boolean }) { return <div className="empty-state"><span className="empty-icon" aria-hidden="true">◎</span><strong>{title}</strong><p>{detail}</p>{action && <button className={primary ? 'button primary' : 'button secondary'} onClick={action}>{actionLabel}</button>}</div>; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
function safeErrorLabel(code: string) { const labels: Record<string, string> = { account_not_found: 'La cuenta indicada no existe.', connection_not_found: 'La conexión indicada no existe.', invalid_request: 'Revise los campos e inténtelo de nuevo.', origin_or_csrf_rejected: 'La solicitud local no superó la protección de origen.', operation_rejected: 'La operación fue rechazada por una condición de seguridad o estado.', account_scan_failed: 'No se pudo completar el análisis para una cuenta.', follow_gate_invalid: 'La opción «Pedir primero que me sigan» no es válida.', follow_gate_message_invalid: 'Revise el «Mensaje previo»: es obligatorio, de hasta 640 caracteres y solo admite las variables indicadas.', follow_gate_button_title_invalid: 'Revise el «Título del botón»: de 1 a 20 caracteres, sin enlaces ni saltos de línea.', follow_gate_retired: FOLLOW_GATE_RETIRED_LABEL, interactive_mode_retired: INTERACTIVE_RETIRED_LABEL, ...ATTACHMENT_ERROR_LABELS }; return labels[code] ?? 'Revise el estado de la cuenta y vuelva a intentarlo.'; }
