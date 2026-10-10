# Referencia técnica

Documento de referencia para quien mantiene o audita Social Desk. Describe la arquitectura, el esquema de datos, la máquina de estados de la cola y las reglas de seguridad tal como están en el código. Para instalar, ver [INSTALACION-CON-IA.md](INSTALACION-CON-IA.md); para las convenciones de desarrollo, [AGENTS.md](../AGENTS.md).

## Contenido

1. [Arquitectura](#1-arquitectura)
2. [Configuración y carpeta de datos](#2-configuración-y-carpeta-de-datos)
3. [Esquema y migraciones](#3-esquema-y-migraciones)
4. [Conexiones](#4-conexiones)
5. [Automatizaciones](#5-automatizaciones)
6. [Monitoreo y programador](#6-monitoreo-y-programador)
7. [Revisión pendiente (escaneo de comentarios anteriores)](#7-revisión-pendiente-escaneo-de-comentarios-anteriores)
8. [Clasificación de comentarios](#8-clasificación-de-comentarios)
9. [Cola: estados y envío](#9-cola-estados-y-envío)
10. [Lectura de comprobación (read-back)](#10-lectura-de-comprobación-read-back)
11. [Respuesta pública opcional](#11-respuesta-pública-opcional)
12. [Modo real y retención heredada](#12-modo-real-y-retención-heredada)
13. [Modelo de seguridad](#13-modelo-de-seguridad)
14. [Límites de volumen](#14-límites-de-volumen)
15. [Limitaciones conocidas](#15-limitaciones-conocidas)
16. [Fase 0 del follow gate (experimental)](#16-fase-0-del-follow-gate-experimental)
17. [Pedir que me sigan (follow gate de confianza) — RETIRADA](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo)
18. [Adjunto del recurso por URL — RETIRADA](#18-adjunto-del-recurso-por-url--retirada-código-inactivo)
19. [Moderación de comentarios](#19-moderación-de-comentarios)

## 1. Arquitectura

Un solo proceso Node.js (`server.ts`, ejecutado con `tsx`) contiene todo:

| Pieza | Archivo | Responsabilidad |
| --- | --- | --- |
| Arranque | `server.ts` | Carga la configuración, toma el bloqueo de instancia, abre la base de datos, aplica migraciones, crea la bóveda y los servicios, y atiende HTTP. Las rutas `/api/*` van al router propio; el resto, a Next.js. |
| Configuración | `src/core/config.ts` | Variables de entorno (ver [sección 2](#2-configuración-y-carpeta-de-datos)); host fijo `127.0.0.1`. |
| Bloqueo de instancia | `src/core/application-lock.ts` | Archivo `.application-owner.json` en la carpeta de datos con PID, hora de inicio del proceso (o `null` si la plataforma no la ofrece) y un nonce. Un bloqueo solo se recupera si su dueño está demostrablemente muerto (ver [Bloqueo de instancia por plataforma](#bloqueo-de-instancia-por-plataforma)). |
| Base de datos | `src/db/` | SQLite integrado (`node:sqlite`), migraciones versionadas, consultas compartidas. |
| Bóveda | `src/security/vault.ts` | Cifrado AES-256-GCM de tokens con `vault.key`. |
| Proveedor | `src/providers/meta/provider.ts` | Única capa que habla con la Graph API (timeout de 10 s por solicitud, cuerpo máximo 1 MiB, 100 elementos por página). |
| Servicios | `src/services/` | Conexiones, automatizaciones, escáner, revisión pendiente, cola, respuesta pública, programador e interbloqueo heredado. |
| API | `src/http/router.ts` | API JSON con guardas de host, origen y CSRF; cuerpo máximo de 64 KiB; DTOs con campos permitidos. |
| Interfaz | `app/` | Aplicación Next.js (App Router) de una sola página, en español. |

Modos de ejecución:

- `npm start` → `node scripts/start.mjs`: pone `NODE_ENV=production` antes de cargar nada y luego carga `server.ts` en el mismo proceso con la API programática de `tsx` (ganchos CommonJS y ESM, igual que `node --import tsx`). Usa la compilación de `.next` (requiere `npm run build`). Funciona igual en PowerShell, `cmd`, macOS y Linux; el PID del bloqueo es el de ese proceso y `SIGINT`/`SIGTERM` llegan directo a sus manejadores de cierre.
- `npm run dev` → `tsx server.ts`: Next.js en modo desarrollo (cualquier `NODE_ENV` distinto de `production`).
- `tsx` es una dependencia de producción (no de desarrollo) porque `scripts/start.mjs` la carga, y la configuración de Next.js es `next.config.mjs` (JavaScript) para que el arranque no necesite el compilador nativo SWC; ambas cosas las exige el instalador de Windows y las comprueba `tests/start-script.test.ts`.
- Instalador de Windows (`packaging/windows/`, ver su [README](../packaging/windows/README.md)): Node.js portátil + `.next` compilado + `node_modules` de producción; el lanzador `launch.ps1` ejecuta `node\node.exe app\scripts\start.mjs` oculto con `LOCAL_SOCIAL_DATA_DIR=%LOCALAPPDATA%\SocialDesk\data` y `PORT` 3000 (o 3001-3020); `stop.ps1` lo termina con `taskkill /T /F`.
- Ningún script de `package.json` usa sintaxis propia de una terminal (`VAR=valor`, `$(...)`, `&&`); lo comprueba `tests/start-script.test.ts`.

La API expone `GET /api/health` → `{"status":"ok","ready":true}` (otros métodos: 405) y `GET /api/session` → token CSRF del proceso.

## 2. Configuración y carpeta de datos

| Elemento | Valor |
| --- | --- |
| Host | Siempre `127.0.0.1`. |
| Puerto | `PORT`, entero 1–65535; por defecto `3000`. |
| Carpeta de datos | `LOCAL_SOCIAL_DATA_DIR` (se resuelve a ruta absoluta) o `./data` relativa al directorio de trabajo. Permisos `0700`. |
| Base de datos | `<datos>/social-automation.sqlite`, permisos `0600`, `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. |
| Llave de la bóveda | `<datos>/vault.key`, 32 bytes aleatorios, permisos `0600`, fuera de SQLite. Se crea solo si no existe **y** no hay credenciales cifradas. |
| Bloqueo | `<datos>/.application-owner.json` (`0600`). Se libera al cerrar con `SIGINT`/`SIGTERM`. |

En Windows los modos `0700`/`0600` no tienen efecto; la carpeta queda protegida solo por los permisos del usuario.

### Variables de entorno

| Variable | Por defecto | Efecto |
| --- | --- | --- |
| `PORT` | `3000` | Puerto (entero 1–65535; otro valor detiene el arranque). |
| `LOCAL_SOCIAL_DATA_DIR` | `./data` | Carpeta de datos. |
| `SOCIAL_DESK_IMPORT_ENV_PATH` | sin definir | Ruta del único archivo que lee **Importar `.env`**. Sin definir, la importación está desactivada: el endpoint responde `503 environment_import_unavailable` y la interfaz oculta el botón. |
| `SOCIAL_DESK_LEGACY_ACCOUNTS_DIR` | sin definir | Carpeta de otra herramienta con una subcarpeta por cuenta (`run.lock`, contadores de rechazos). Sin definir, no se lee ni se escribe ninguna carpeta heredada. |
| `SOCIAL_DESK_LEGACY_HOLD_USERNAMES` | vacía | Usuarios separados por comas que empiezan retenidos al seleccionarlos. Se normalizan (sin `@`, minúsculas); un nombre inválido detiene el arranque. |

Las rutas relativas se resuelven desde el directorio de trabajo; en las rutas `SOCIAL_DESK_*`, `~/` se expande a la carpeta personal. `GET /api/settings/features` → `{ envImport, legacyInterlock }` informa a la interfaz qué funciones opcionales están activas.

### Bloqueo de instancia por plataforma

`acquireApplicationLock(dir, { probe?, pid? })` crea `.application-owner.json` con `open(..., 'wx')`. Si ya existe, solo lo recupera (bajo un archivo `.reclaim` exclusivo) cuando el dueño anotado está **demostrablemente muerto**; si no, falla con `Application data directory is already running or ownership is uncertain`. La sonda de plataforma (`ProcessProbe`) es inyectable para las pruebas.

| Situación | Linux (con `/proc`) | macOS / Windows (sin `/proc`) |
| --- | --- | --- |
| `process.kill(pid, 0)` da `ESRCH` (no existe) | Muerto: se recupera. | Muerto: se recupera. |
| Vivo (`kill` funciona o da `EPERM`) y la hora de inicio de `/proc/<pid>/stat` coincide | Dueño real: se rechaza. | — |
| Vivo y la hora de inicio difiere | PID reutilizado: se recupera. | — |
| Vivo y no hay hora de inicio comparable | Se rechaza (falla cerrado). | Se rechaza (falla cerrado): no se puede descartar la reutilización del PID. |
| Cualquier otro error de `kill`, o archivo de bloqueo dañado | Se rechaza. | Se rechaza. |

Consecuencia en macOS/Windows: tras un cierre forzado, si el PID anotado ya lo usa otro proceso, el humano debe confirmar que no hay otra instancia y borrar el archivo a mano. Con el instalador de Windows, el lanzador (`launch.ps1`) lo resuelve: si el PID anotado pertenece ahora a un programa que no es Social Desk (ni el `node.exe` de la instalación ni una línea de comandos con `start.mjs`/`server.ts`), borra ese bloqueo antes de arrancar; `stop.ps1` lo borra tras detener el proceso que lo tenía.
Estado global en la tabla `app_state`:

- `dry_run`: `true` en una base nueva; se conserva entre reinicios.
- `monitoring_enabled`: se fuerza a `false` en cada arranque, y todas las cuentas quedan con el monitoreo en pausa.

### Pérdida de la llave

Si falta `vault.key` mientras existen credenciales cifradas, o una credencial no se puede autenticar con la llave existente, el arranque falla a propósito (`Vault key is missing…` / `Vault key is invalid…`). Nunca se crea una llave de reemplazo en silencio ni se sobrescribe la base. Restaura la llave correspondiente desde la copia de seguridad o, si se perdió, mueve la carpeta de datos a otro lugar y vuelve a crear las conexiones con tokens nuevos.

Respalda siempre la carpeta completa (base **y** llave) con la aplicación detenida.

## 3. Esquema y migraciones

`src/db/migrations.ts` aplica en **una sola transacción** todas las migraciones pendientes al arrancar y deja la versión en `PRAGMA user_version`. La versión actual es **18**. Una base con versión mayor que la soportada se rechaza (`Database schema version N is newer than supported version 18`), así que no hay vuelta atrás sin una copia de seguridad.

| Versión | Cambio |
| --- | --- |
| v1 | Esquema inicial: `connections` (token cifrado: nonce, ciphertext, tag), `social_accounts`, `media`, `comments`, `automations`, `automation_keywords`, `queue_items`, `send_attempts` (solo inserción, con triggers), `checkpoints`, `app_state` (`dry_run=true`, `monitoring_enabled=false`). |
| v2 | Índice único `queue_one_initial_reply_per_comment` (`account_id, comment_id`): una respuesta privada por comentario. La migración se niega a avanzar si ya hay duplicados, sin borrar historial. |
| v3 | Ciclo de vida de conexiones: borrado lógico (`deleted_at`), `monitoring_paused` en conexiones y cuentas, identidad observada, capacidades y token de página cifrado por cuenta. |
| v4 | Identidad observada de la cuenta: `account_type`, `related_page_id`. |
| v5 | Motor de automatizaciones: `real_enabled`, botones, `monitoring_started_at`, `version` de plantilla; reintentos en la cola (`attempt_count`, `next_attempt_at`); tablas `scan_runs`, `comment_classifications` y `account_send_holds`. |
| v6 | `legacy_account_acknowledgements`: reconocimiento del contador heredado ligado a su versión. |
| v7 | `comment_classifications.scan_id`: procedencia de cada clasificación (qué escaneo la produjo). |
| v8 | `queue_items.state_reason_code`: motivo seguro de transiciones que no son intentos (por ejemplo `EXPIRED`). |
| v9 | `media.caption` y `media.media_type` (solo para mostrar; anulables). |
| v10 | Reconstrucción de `automations` para añadir `scope` y permitir `media_id` nulo, con `CHECK ((scope='media' AND media_id IS NOT NULL) OR (scope='account' AND media_id IS NULL))`. Se hace con las foreign keys desactivadas temporalmente (para que el `ON DELETE CASCADE` de las palabras clave no se dispare), se verifica `PRAGMA foreign_key_check` antes de confirmar y se restauran. Las filas existentes pasan a `scope='media'` sin cambiar IDs. |
| v11 | Respuesta pública (solo aditiva): `automations.public_reply_enabled`, `public_reply_variants_json`; en `queue_items`: `public_reply_state`, `public_reply_text`, `public_reply_attempts`, `public_reply_next_at`, `public_reply_variant`, `public_reply_selected_at`; tabla de solo inserción `public_reply_attempts` con índice único que permite como máximo un evento `accepted` por elemento. |
| v12 | Fase 0 del follow gate (experimental, solo aditiva): `comments.author_igsid` (anulable; ID opaco del autor tomado de `from.id`), `automations.interactive_mode` (`'none'` por defecto, `CHECK` en `none`/`quick_reply`/`postback`) e `automations.interactive_titles_json` (`'[]'` por defecto). No reconstruye tablas. Ver [sección 16](#16-fase-0-del-follow-gate-experimental). |
| v13 | «Pedir que me sigan» (solo aditiva): `automations.follow_gate_enabled` (`0` por defecto, `CHECK` 0/1), `follow_gate_message` (`''`), `follow_gate_button_title` (`'Ya te sigo'`); tablas `gate_sessions` y `gate_events` (solo inserción, a lo sumo un `tap_detected` y un `resource_accepted` por sesión). Las automatizaciones existentes quedan con la opción apagada. Ver [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo). |
| v14 | Adjunto del recurso (solo aditiva): `automations.resource_attachment_kind` y `gate_sessions.resource_attachment_kind` (`''` por defecto, `CHECK` en `''`/`image`/`audio`/`video`/`file`), `automations.resource_attachment_url` y `gate_sessions.resource_attachment_url` (`''`); tabla `gate_part_events` (solo inserción, a lo sumo un `accepted` por sesión y parte). Filas existentes: sin adjunto, sin cambios. Ver [sección 18](#18-adjunto-del-recurso-por-url--retirada-código-inactivo). |
| v15 | `media.thumbnail_url` (solo aditiva): URL de imagen de miniatura. |
| v16 | Moderación de comentarios (solo aditiva): tablas `moderation_settings`, `moderation_flags` y `moderation_actions` (solo inserción). Ver [sección 19](#19-moderación-de-comentarios). |
| v17 | Revisión con IA: reconstruye `moderation_flags` (SQLite no puede cambiar un `CHECK`) para que `category` acepte `ai_insult`, `ai_hate`, `ai_spam` y `ai_complaint`, copiando todas las filas sin cambios; tablas nuevas `moderation_ai_settings` y `moderation_ai_jobs` (índice único parcial: un trabajo `running` por cuenta). Ver [Revisión con IA](#revisión-con-ia). |
| v18 | Modelo local (solo aditiva): `moderation_ai_settings.local_model` (anulable), para que elegir el modelo local no pise el modelo de Gemini. Ver [Modelo local](#modelo-local). |

> **Importante:** respalda la carpeta de datos antes del primer arranque de cada versión que traiga migraciones.

## 4. Conexiones

Una conexión tiene nombre, tipo de inicio de sesión, App ID opcional, versión de Graph API y token de acceso. El token se envía una vez, se guarda cifrado y no se vuelve a mostrar.

- **Instagram Login** (`graph.instagram.com`): el descubrimiento lee la identidad del propio token (`/me`: id, username, tipo de cuenta) y devuelve una cuenta.
- **Facebook Login** (`graph.facebook.com`): el descubrimiento lista las páginas accesibles (`/me/accounts`) y las cuentas de Instagram Business vinculadas.

Flujo: **Probar y descubrir** valida el token y lista cuentas candidatas; luego se elige la cuenta. Cambiar el token, el App ID o la versión de Graph invalida la validación y pausa el monitoreo de esa conexión hasta revalidarla. Antes de cada envío real, el token actual debe seguir siendo dueño de la cuenta elegida. Desconectar y eliminar conservan el historial.

**Importar `.env`** (Ajustes) es opcional y está **desactivada** salvo que se defina `SOCIAL_DESK_IMPORT_ENV_PATH`. Es una acción explícita y confirmada que crea una conexión a partir de ese único archivo (la ruta la fija quien inicia el servidor; el cliente no puede indicar otra). Lee `META_LOGIN_KIND`, `INSTAGRAM_ACCESS_TOKEN`/`IG_ACCESS_TOKEN` o `FACEBOOK_USER_ACCESS_TOKEN`/`FB_USER_ACCESS_TOKEN`, `META_APP_ID`/`INSTAGRAM_APP_ID`, `GRAPH_API_VERSION` (por defecto `v26.0`) e `IG_USERNAME`/`INSTAGRAM_USERNAME`.

**Publicaciones:** se traen con **Actualizar publicaciones** junto con su texto (recortado a 200 caracteres, solo para mostrar) y su tipo (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`; otros tipos se ignoran). Las filas guardadas antes de v9 muestran «Sin texto · id corto» hasta que se actualizan. Con una sola cuenta, el filtro de cuenta se selecciona solo (una elección explícita, incluida «Todas las cuentas», nunca se pisa); con varias, Publicaciones pide elegir una.

## 5. Automatizaciones

Cada automatización pertenece a una cuenta y tiene:

- Una o más **palabras clave**. La comparación ignora mayúsculas, acentos y espacios extra.
- **Modo de coincidencia:** `contains` (por defecto; frases completas dentro del comentario) o `exact` (el comentario entero debe ser la palabra clave). Un modo inválido es un 400.
- **Plantilla de respuesta** (máximo 1000 caracteres ya renderizada) y **hasta dos botones** con URL HTTPS (título de hasta 20 caracteres; sin usuario/contraseña en la URL).
- Variables de plantilla permitidas: `{{username}}` (quien comenta), `{{comment}}`, `{{keyword}}` (palabra clave que coincidió), `{{account}}` (tu usuario), `{{media}}` (permalink de la publicación o su ID, recortado a 100 caracteres). Cualquier otra variable se rechaza al guardar.
- Al **Activar**, se registra un corte de monitoreo («ahora»): solo los comentarios posteriores son candidatos.
- Editar la plantilla sube su versión; los elementos encolados con una versión anterior no se envían.
- Archivar conserva el historial.

### Automatizaciones generales (toda la cuenta)

El campo `scope` puede ser `media` (por defecto, una publicación) o `account` («Todas las publicaciones (general)», insignia «General»), que aplica a todas las publicaciones de la cuenta, antiguas y nuevas.

- API: `POST /api/automations` con `scope: "account"` y `mediaId` omitido o `null`. Un `mediaId` con `scope: "account"`, la falta de `mediaId` sin ese scope o un scope desconocido es un 400. En `PUT`, el scope guardado no se puede cambiar (409); para cambiarlo, crea otra automatización.
- **Precedencia:** una publicación con su propia automatización activa y no archivada la atiende solo esa; la general solo aplica a publicaciones sin una propia. Las específicas en pausa, desactivadas o archivadas no cuentan. La misma regla se aplica al escanear, en Revisión pendiente, al encolar y en la revalidación previa al envío: un elemento general cuya publicación ganó una automatización propia pasa a `SKIPPED` (`yielded_to_media_automation`) antes de cualquier intención o POST. Dos automatizaciones **activas** que reclaman el mismo comentario lo vuelven ambiguo y requiere revisión.
- Los comentarios antiguos nunca se procesan solos: se revisan en Revisión pendiente.

## 6. Monitoreo y programador

`src/services/scheduler.ts`. El Monitoreo se enciende por cuenta o para todas, y **siempre arranca apagado**.

| Parámetro | Valor |
| --- | --- |
| Intervalo del programador | 60 s (el primer ciclo ocurre 60 s después de encender). |
| Automatizaciones específicas | Se escanean en cada ciclo: primera página de comentarios más, como máximo, una página de continuación con el cursor guardado. |
| Automatizaciones generales | La lista de publicaciones de la cuenta se refresca como máximo cada **5 min**; cada publicación cubierta se escanea como máximo cada **2 min**, primero las nunca escaneadas; tope de **25** escaneos generales por ciclo entre todas las cuentas. Un error del proveedor detiene los escaneos generales de esa cuenta en ese ciclo. Estos tiempos viven en memoria y se reinician con el proceso. |
| Separación entre envíos privados | 10 s mínimo entre intenciones de envío; un envío a la vez. |
| Respuesta pública | Después del paso privado, como máximo una por ciclo, con 20 s mínimo entre intenciones públicas. |

En cada ciclo también se ejecuta el barrido de expiración (`expireStale`). Al arrancar, el programador recupera los envíos interrumpidos y expira los vencidos. La cobertura se informa como parcial hasta que la paginación termina.

## 7. Revisión pendiente (escaneo de comentarios anteriores)

- **Analizar** (ventanas de 2 h, 24 h, 3 días, 7 días o personalizada) **solo lee y clasifica**: nunca envía ni encola. Lee hasta 100 páginas por publicación.
- Un escaneo que encuentra un cursor repetido, un error del proveedor o el límite de páginas termina **incompleto**, y sus clasificaciones no se pueden procesar.
- Progreso: `GET /api/backlog/jobs/:id` devuelve `progress` `{ mediaDone, mediaTotal, pagesRead, commentsSeen, currentStartedAt? }`, acumulado entre cuentas y actualizado tras cada página. La interfaz muestra barra de progreso, tiempo transcurrido, botón Cancelar (`POST /api/backlog/jobs/:id/cancel`) y un resumen al terminar. Si recargas la página, el ID del trabajo se guarda en `sessionStorage` y el seguimiento continúa.
- Lista persistente: `GET /api/backlog/pending?accountId=<id>&limit=&offset=` (solo lectura; cuenta obligatoria y verificada; límite por defecto 50, máximo 200) devuelve `{ total, lastAnalyzedAt, items, limit, offset }`. Incluye las clasificaciones `eligible` de escaneos **completos** (`backlog`/`catch_up`), excluyendo comentarios ya en la cola, fuera de la ventana de 7 días y de automatizaciones archivadas. Cada elemento trae usuario, texto (recortado a 280 caracteres), palabras clave, fecha de análisis y una vista previa del mensaje (sin secretos ni respuestas crudas del proveedor).
- **Procesar** es una acción separada, explícita y confirmada: `POST /api/backlog/process` con IDs elegidos y `confirmed: true`. El servidor solo encola cada ID si fue clasificado `eligible` para esa cuenta y automatización por un escaneo completo (ni incompleto ni cancelado). Si un solo ID no cumple, se rechaza toda la solicitud y no se encola nada. Si la cuenta tiene exactamente una automatización activa, se elige sola.
- Desactivar Dry Run nunca envía elementos simulados antiguos ni el backlog.

## 8. Clasificación de comentarios

`src/services/automations.ts`. Un comentario es elegible solo si pasa todas las reglas; si no, queda con uno de estos motivos:

| Motivo | Significado |
| --- | --- |
| `eligible` | Puede recibir respuesta privada. |
| `own_authored` | Lo escribió la propia cuenta. |
| `reply_thread` | Es una respuesta dentro de un hilo (no es comentario principal). |
| `missing_author` | No trae autor. El autor se lee del `username` de nivel superior y, si falta (Meta suele omitirlo), de `from.username`. |
| `missing_timestamp` / `invalid_timestamp` / `future_timestamp` | Fecha ausente, inválida o en el futuro. |
| `expired` | Tiene 7 días o más (límite conservador). Los reportes de escaneo lo cuentan aparte como `expiredCount`. |
| `no_keyword_match` | Ninguna palabra clave coincide. |
| `multiple_keyword_matches` | Lo reclaman varias automatizaciones; requiere revisión. |
| `owner_replied` | La cuenta ya le respondió («Ya respondido por la cuenta»): entre los comentarios guardados hay una respuesta a ese comentario escrita por el usuario de la cuenta conectada (sin distinguir mayúsculas, misma cuenta). |

Sobre `owner_replied`: la detección usa las respuestas guardadas por escaneos anteriores; una respuesta creada después del último escaneo no se conoce hasta el siguiente, así que conviene escanear justo antes de procesar. No hay consulta en vivo en el momento del envío; la revalidación previa usa las mismas respuestas guardadas y pasa el elemento a `SKIPPED` (`owner_replied`) antes de cualquier intención o POST.

## 9. Cola: estados y envío

Estados de `queue_items` (respuesta privada):

| Estado | Significado |
| --- | --- |
| `SIMULATED` | Creado en Dry Run o para una automatización no autorizada para envíos reales. Inerte: nunca se envía. La interfaz lo muestra como `WOULD_SEND · No se envió (modo prueba)`. |
| `QUEUED` | Esperando envío en modo real. |
| `SEND_INTENT_RECORDED` / `SENDING` | Intención registrada; hay un POST en curso o fue interrumpido. |
| `SENT` | Meta aceptó el envío y devolvió un ID de mensaje; luego se intenta una lectura de comprobación. |
| `FAILED_RETRYABLE` | Límite de volumen del proveedor (HTTP 429) o fallo al releer el comentario. Se reintenta con espera creciente (10 s, 20 s, 40 s…, máximo 15 min locales), nunca antes de un `Retry-After` del proveedor. Tras 5 intentos pasa a `FAILED_PERMANENT`. |
| `FAILED_PERMANENT` | Rechazo definitivo del proveedor o reintentos agotados. |
| `UNKNOWN_OUTCOME` | Resultado ambiguo (timeout, respuesta malformada o error del servidor después del envío, aceptado sin ID de mensaje, o reinicio después de la intención). **Nunca se reintenta automáticamente.** |
| `SKIPPED` | La revalidación previa al envío encontró que ya no está permitido. El motivo, si existe, va en `state_reason_code` y aparece como `safeErrorCode` en `GET /api/queue` (por ejemplo `owner_replied`, `yielded_to_media_automation`, `interactive_mode_retired` o `follow_gate_retired`). |
| `EXPIRED` | El comentario alcanzó la ventana de 7 días. Ver abajo. |

Existen además `DISCOVERED` y `MATCHED` en el `CHECK` del esquema, sin uso en el flujo actual.

### Secuencia de envío

1. El elemento debe estar `QUEUED` (o `FAILED_RETRYABLE` vencido), con Dry Run desactivado, automatización activa y autorizada, cuenta/conexión válidas, monitoreo activo y sin retención.
2. Se relee el comentario y se revalida (expiración, `owner_replied`, precedencia, versión de plantilla).
3. Se confirma en la base una **intención inmutable** (`intent_recorded`, estado `SENDING`).
4. Se hace el POST a Meta.
5. Se registra el resultado (`accepted`, `definitive_rejection`, `retryable_failure`, `ambiguous_outcome`) en `send_attempts`, que es de solo inserción.

Al arrancar, cualquier elemento que quedó en `SEND_INTENT_RECORDED` o `SENDING` pasa a `UNKNOWN_OUTCOME` (código `process_interrupted_after_intent`).

### Expiración

`EXPIRED` se asigna: (a) justo antes de un envío, después de releer el comentario y antes de cualquier intención, así que no hay POST; (b) en un barrido acotado e idempotente (`QueueService.expireStale`, hasta 500 elementos) al arrancar y en cada ciclo del programador, sobre `QUEUED`, `FAILED_RETRYABLE` y `SIMULATED`; (c) cuando un reintento caería fuera de la ventana. Nunca toca `SENT`, `SENDING`, `SEND_INTENT_RECORDED`, `UNKNOWN_OUTCOME` ni `FAILED_PERMANENT`. Se guarda el motivo `private_reply_window_elapsed` y no se escribe evento de intento, porque no se envió nada.

### Resolver un `UNKNOWN_OUTCOME`

La aplicación no lo reenvía y no tiene un control para cambiar su estado. Abre su historial de intentos en **Cola e historial**, comprueba en Instagram (por ejemplo, en la conversación con esa persona) si el mensaje llegó y, si no llegó, atiende el comentario a mano o crea un disparador nuevo.

### API de la cola

`GET /api/queue` incluye en cada elemento `commentUsername`, un `commentText` recortado y `publicReply` (o `null`). `GET /api/queue/:id/attempts` devuelve los eventos privados y `publicEvents`. El panel «Ver» muestra el texto y los botones del mensaje.

## 10. Lectura de comprobación (read-back)

Después de que Meta acepta un envío se intenta una lectura y se registra como evento `readback`:

- El remitente se acepta si Meta informa el ID de proveedor de la cuenta **o** su usuario (con la misma normalización), porque Meta puede devolver el ID de la cuenta de Instagram en lugar del ID con alcance de app de Instagram Login. El ID de mensaje debe coincidir y debe haber un destinatario.
- Para mensajes con botones se compara la forma real `attachments.data[].generic_template` (título y botones `cta`) con lo enviado. El evento guarda solo `observedMatches` y un `matchReason` corto (`match`, `text_mismatch`, `buttons_mismatch`, `content_unavailable`), nunca la respuesta cruda. Una diferencia nunca provoca reenvío ni cambio de estado.
- Si la lectura falla se guarda el código seguro real (por ejemplo `meta_readback_mismatch`, `http_5xx`, `timeout`); `readback_unavailable` es solo el valor de respaldo.

Botón **Verificar lectura** en un elemento `SENT`: `POST /api/queue/:id/readback` con `{accountId}` (mismas guardas de origen y CSRF). Lee una vez, agrega otro evento `readback` y devuelve `{observed, safeErrorCode?, matches?}`. Nunca envía ni cambia el estado; como máximo una llamada por elemento cada 30 s (429 `readback_rate_limited`; el límite vive en memoria). Una lectura correcta no prueba cómo se vio el mensaje ni si se pulsaron los botones.

## 11. Respuesta pública opcional

Una automatización puede, además de la respuesta privada, responder **públicamente** debajo del comentario. Se activa con «Responder también públicamente al comentario» y una variante por línea («Variantes de la respuesta pública»). El formulario muestra el número de variantes y dos ejemplos renderizados; las tarjetas muestran «Respuesta pública · N variantes».

- **API:** `POST /api/automations` y `PUT /api/automations/:id` aceptan `publicReplyEnabled` (booleano) y `publicReplyVariants` (arreglo de textos). No se convierten tipos: un valor de otro tipo o una variante inválida es un 400; activar exige al menos una variante. En `PUT`, los campos omitidos conservan lo guardado.
- **Reglas de variantes:** máximo 50, cada una de 1 a 300 caracteres tras recortar espacios, distintas tras normalizar (mayúsculas, acentos, espacios), total máximo 10 000 caracteres. Solo se permiten `{{username}}` y `{{keyword}}` (primera palabra clave que coincidió); se permite la mención literal `@{{username}}`, pero se rechazan enlaces (`http(s)://`, `www.`) y cualquier otro `@usuario`. El texto renderizado no puede pasar de 1000 caracteres.
- **Rotación:** por cuenta se evitan las últimas 3 variantes usadas si la automatización tiene más de 3; si no, solo se evita la inmediatamente anterior (con una sola variante, se repite). El texto exacto queda guardado en el elemento.
- **Orden garantizado — privado primero, público después:** el paso público solo se programa si la respuesta privada fue **aceptada** (`SENT` con ID de mensaje), la automatización tiene la respuesta pública activada con al menos una variante y Dry Run está desactivado. Queda `PENDING` en la **misma transacción** que registra la privada aceptada. Un fallo, resultado ambiguo u omisión de la privada nunca programa una pública.
- **La privada nunca se repite:** el paso público tiene su propio estado (`public_reply_state`) y su propia tabla de intentos (`public_reply_attempts`, solo inserción). Ningún resultado público cambia el `SENT` privado.
- **Procesamiento:** `QueueService.processPublicReply()` corre después del paso privado en cada ciclo: como máximo una respuesta pública por ciclo, una a la vez, nunca en paralelo con un envío privado de la misma cuenta, y con al menos **20 s** entre intenciones públicas (aparte de los 10 s de las privadas). Antes del POST se confirma una intención (`SENDING` + evento `intent_recorded`) y se revalida: Dry Run desactivado, cuenta/conexión válidas y monitoreo activo, sin retención (ni interbloqueo heredado), privada en `SENT`. Si la automatización se pausó, archivó, perdió la autorización real o desactivó la respuesta pública desde el envío privado, pasa a `SKIPPED`. Si pasaron más de 24 h desde el envío privado, pasa a `EXPIRED` sin POST.
- **Fallos y reintentos:** un resultado ambiguo (timeout, error de red o redirección, 5xx, cuerpo malformado, aceptado sin ID, o reinicio en `SENDING`) queda `UNKNOWN_OUTCOME` y **nunca** se reintenta. Un rechazo de permisos/OAuth (códigos de Meta 3, 10, 102, 190, 200–299) queda `FAILED` con `public_reply_permission_denied` («Falta el permiso para responder comentarios en esta conexión»). Un límite de volumen (HTTP 429 o códigos 4, 17, 32, 613) se reintenta como máximo 3 intentos en total, nunca antes de `Retry-After` (si no hay, 30 s, 60 s…, máximo 15 min); si el reintento caería después de las 24 h, expira. Cualquier otro rechazo definitivo queda `FAILED`.
- **Reintento manual:** una pública `FAILED` (siempre un rechazo definitivo, así que se sabe que no se publicó) muestra «Reintentar respuesta pública» en el panel «Ver» (`POST /api/queue/:id/public-reply/retry` con `{accountId}`; solo `FAILED`, solo dentro de las 24 h). Solo vuelve el paso público a `PENDING` y registra un evento `manual_retry`.
- **Dry Run:** el texto que se habría publicado se guarda como vista previa inerte y se muestra como `WOULD_REPLY_PUBLIC · No se publicó (modo prueba)`. No se llama al proveedor.
- **DTO:** `publicReply: { state, text, attempts, nextAt, safeErrorCode, replyId, preview }`. Estados en la interfaz: Pendiente, Enviando, Publicada, Falló, Resultado desconocido, Omitida, Expirada.
- **API de Meta:** `POST /{ig-comment-id}/replies` con cuerpo JSON `{ "message": "…" }` (nunca en la URL); respuesta `{ "id": "<id del comentario nuevo>" }`. Instagram Login usa `graph.instagram.com` con el token de usuario de Instagram y necesita `instagram_business_basic` + `instagram_business_manage_comments`. Facebook Login usa `graph.facebook.com` con el token de página de la cuenta y necesita `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` (y `ads_management`/`ads_read` para roles de Business Manager). Meta solo permite responder a comentarios principales, no ocultos ni de transmisiones en vivo. Fuentes: <https://developers.facebook.com/docs/instagram-platform/comment-moderation> y <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies>.
- **Relación con `owner_replied`:** la respuesta pública la escribe la propia cuenta, así que un escaneo posterior clasificará ese comentario como `owner_replied`. No afecta al elemento que la produjo: la privada ya se envió antes y la unicidad de la cola impide volver a encolarlo.
- Al arrancar, cualquier pública en `SENDING` pasa a `UNKNOWN_OUTCOME`.

## 12. Modo real y retención heredada

En Dry Run (o para una automatización sin autorización real) los comentarios elegibles se convierten en `SIMULATED`. Un envío real exige **todo** lo siguiente:

1. Dry Run global desactivado, con confirmación explícita.
2. La automatización activa y autorizada aparte para envíos reales (**Autorizar real**, con confirmación).
3. Cuenta, conexión y token válidos, y monitoreo no pausado.
4. Sin retención de envío en la cuenta (ver abajo).
5. El elemento debe haberse encolado con la versión actual de la plantilla.

### Retención heredada (opcional)

Sirve para convivir con una herramienta anterior que guardaba una carpeta por cuenta. Está **desactivada** si no se define ninguna de estas variables; entonces `legacyInterlockFromConfig` devuelve `undefined`, ninguna cuenta empieza retenida, no se lee ningún archivo y la cola envía sin interbloqueo.

- `SOCIAL_DESK_LEGACY_ACCOUNTS_DIR`: en `<dir>/<usuario normalizado>/` se buscan `run.lock` y el primer contador existente (`rejection-counter.json`, `rejection_counter.json`, `private-reply-counter.json`, `private_reply_rejections.json`, `private-reply-rejection-counter.json`); su versión es el SHA-256 del contenido (`absent` si no hay, `unreadable` si no se puede leer).
- `SOCIAL_DESK_LEGACY_HOLD_USERNAMES`: cuentas que requieren reconocimiento aunque no haya contador (motivo `legacy_historical_rejection`).
- Al **seleccionar** una cuenta, si hay `run.lock`, historial de rechazos o el usuario está en la lista, se crea una retención (`legacy_lock_present`, `legacy_rejection_history` o `legacy_historical_rejection`).
- **Reconocer** (Conexiones → «Retención heredada» → «Revisar estado y reconocer») exige `confirmed: true`, que no exista `run.lock` y que la versión del contador siga siendo la observada; guarda el reconocimiento ligado a esa versión y quita las retenciones `legacy_*` de la cuenta. Si el contador cambia, hay que reconocer de nuevo.
- Antes de cada envío (privado y público) se vuelve a comprobar: sin `run.lock` ajeno, contador legible y, si hay contador o la cuenta está en la lista, un reconocimiento de esa misma versión. Con carpeta configurada, el envío se hace mientras la aplicación tiene su propio `run.lock` (creado con `wx` y borrado solo si sigue siendo suyo). Nunca se modifican ni borran los archivos de la otra herramienta.
- Si se desactiva la función, una retención `legacy_*` que quedó en la base se puede reconocer igual (contra la versión `absent`); los reconocimientos existentes se conservan.

## 13. Modelo de seguridad

- **Solo local:** el servidor escucha en `127.0.0.1` y responde 421 (`invalid_local_host`) a cualquier `Host` distinto de `127.0.0.1` o `localhost`.
- **Escrituras protegidas:** todo método distinto de `GET`/`HEAD` exige `Origin` igual al host, cabecera `x-csrf-token` con el token del proceso (se obtiene en `GET /api/session` y cambia en cada arranque) y cuerpo JSON (`application/json`, máximo 64 KiB). Si no, 403 `origin_or_csrf_rejected`.
- **Cabeceras:** `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`.
- **Secretos:** tokens cifrados con AES-256-GCM; nunca se devuelven al navegador; las respuestas usan campos permitidos; los errores se reducen a códigos seguros; `redactSecrets` elimina tokens y cabeceras `Bearer` de cualquier texto.
- **Acotado por cuenta:** cada operación sobre cola, automatización o publicación verifica que pertenece a la cuenta indicada.
- **Historial inmutable:** `send_attempts` y `public_reply_attempts` rechazan `UPDATE` y `DELETE` mediante triggers.
- **Fuera de alcance:** un usuario del sistema operativo comprometido puede leer la llave y la base. No hay autenticación más allá del acceso local y el token CSRF.

## 14. Límites de volumen

Los valores por defecto son prudentes y locales, no una garantía de que Meta acepte el volumen: monitoreo cada 60 s, 10 s mínimo entre intenciones privadas, 20 s entre públicas, un envío a la vez y reintentos acotados. Los límites reales dependen de tu app y tu cuenta en Meta; la aplicación registra las cabeceras de uso que ve, pero no aplica las cuotas de Meta.

## 15. Limitaciones conocidas

- Un usuario, una máquina, solo loopback; sin autenticación aparte del acceso local y el token CSRF.
- Sistemas: Linux verificado en una ejecución real. macOS y Windows nativo están verificados solo por pruebas automáticas con una sonda de plataforma simulada; no se probaron en un equipo real. Sin `/proc`, un bloqueo huérfano cuyo PID fue reutilizado exige intervención manual (ver [Bloqueo de instancia por plataforma](#bloqueo-de-instancia-por-plataforma)).
- Sin TikTok, sin despliegue en la nube, sin infraestructura de colas, sin IA.
- Los textos de publicaciones se guardan solo para mostrar (200 caracteres); `{{media}}` sigue siendo el permalink o el ID.
- No hay forma de resolver `UNKNOWN_OUTCOME` dentro de la aplicación.
- El listado de publicaciones (endpoint `/api/media`) extrae los campos `media_url` y `thumbnail_url` de Graph API y se exponen como `thumbnailUrl`. Las miniaturas en la base de datos se reescriben en cada recarga porque las URL del CDN de Meta expiran.
- El Monitoreo revisa la primera página de comentarios (más una continuación) en cada ciclo; el historial profundo se cubre poco a poco o con un escaneo de Revisión pendiente, y puede quedar parcial.
- La detección de «ya respondido» depende de las respuestas guardadas por escaneos anteriores; no hay comprobación en vivo al enviar.
- El comportamiento de las respuestas privadas (permisos, reglas de 24 h/7 días, cómo se ven los botones) depende de Meta y debe comprobarse con un comentario real controlado antes de un uso amplio.
- La retención heredada solo conoce el formato de carpetas descrito en la sección 12 (`run.lock` y los nombres de contador listados).
- «Pedir que me sigan» y el adjunto del recurso están **retirados** (código inactivo): con una aplicación que solo sondea, Meta rechaza el envío posterior al toque; ver la [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo).

## 16. Fase 0 del follow gate (experimental)

Objetivo: permitir **un experimento controlado** para saber qué acepta Meta antes de construir un «follow gate» (comentario → respuesta privada con botón → comprobar si la persona sigue la cuenta → enviar el recurso). **No** es el follow gate: el toque de un botón **no se procesa** y no se envía nada adicional. El flujo completo de confianza (sin verificación) está en la [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo).

### Qué hace

1. **Identificador del autor.** El escáner guarda `from.id` del comentario en `comments.author_igsid` (solo si tiene forma de ID opaco: letras, números, `_` o `-`, máximo 64). Un escaneo posterior sin `from.id` nunca borra un valor conocido. La respuesta del envío privado (`recipient_id`) se guarda, validada, en el evento `accepted` de `send_attempts` (`details.recipientId`) y aparece en el historial del elemento.
2. **Botones interactivos experimentales: RETIRADOS (v14).** Sus botones no hacían nada al tocarlos; la API rechaza cualquier `interactiveMode` distinto de `none` o `interactiveTitles` no vacío con `400 interactive_mode_retired`, el encolado ignora un `interactive_mode` heredado y un elemento ya congelado con esos botones se omite (`SKIPPED`, `interactive_mode_retired`); las columnas se conservan y el botón postback del follow gate sigue igual.
3. **Diagnóstico de solo lectura.** `GET /api/diagnostics/conversation?accountId=&commentId=` (exige además el token CSRF de la sesión, aunque sea GET) busca la conversación con el autor, lee como máximo los 20 mensajes más recientes y consulta el perfil. Responde con un resumen saneado: ID del autor recortado (`…1234`), por mensaje `id`, fecha, dirección (`account`/`user`), texto recortado a 80 caracteres, `keys` (nombres de los campos presentes en el mensaje, nunca sus valores) y forma de los adjuntos; del perfil solo `isUserFollowBusiness` e `isBusinessFollowUser`. Errores: `404 comment_not_found` (el comentario no es de esa cuenta), `409 igsid_unknown` (aún no hay `author_igsid`), `429 diagnostics_rate_limited` (1 llamada por comentario cada 20 s, en memoria), `503 diagnostics_unavailable`. Entre llamadas a Meta espera 0,5 s (Meta documenta 2 llamadas por segundo), así que tarda unos 10 s.

### Formas JSON enviadas (POST `/{ig-id}/messages`, con `recipient: { comment_id }`)

- Respuestas rápidas (retiradas; el proveedor las rechaza antes de llamar a Meta): `message: { text, quick_replies: [{ content_type: "text", title, payload }] }` — [Quick Replies](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/quick-replies).
- Postback (lo usa el follow gate): `message: { attachment: { type: "template", payload: { template_type: "button", text, buttons: [{ type: "web_url", title, url }…, { type: "postback", title, payload }…] } } }` — [Button Template](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/button-template).
- Respuesta privada: [Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies) (respuesta `{ recipient_id, message_id }`); conversación: [Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api); perfil: [User Profile](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile).

Si Meta rechaza explícitamente el mensaje con botones (HTTP 400 que no sea de token, permisos ni límite de uso), el resultado es un rechazo definitivo con código `interactive_payload_rejected` (`FAILED_PERMANENT`, sin reintento). Timeouts, 5xx o respuestas sin ID siguen siendo `UNKNOWN_OUTCOME` y nunca se reintentan.

### Verificado y NO VERIFICADO

- Verificado con pruebas automáticas (proveedor simulado): las formas JSON exactas, los límites, la clasificación de errores, el saneamiento del diagnóstico y que el modo `none` no cambia.
- **NO VERIFICADO** contra Meta: que una respuesta privada (`recipient.comment_id`) acepte respuestas rápidas o botones postback (la guía de respuestas privadas solo muestra texto); cómo aparece un toque al leer la conversación (se documenta que una respuesta rápida se publica como mensaje del usuario con el título; un postback puede no aparecer); si un toque cuenta como consentimiento para leer el perfil (la documentación solo menciona mensajes, icebreakers y menú persistente); si `from.id` del comentario es el mismo IGSID que `recipient_id`; el código numérico del error de consentimiento (se reconoce por su texto). Las `keys` solo pueden mostrar los campos pedidos (`id, created_time, from, to, message, attachments`).

### El experimento

Ya se hizo: la respuesta privada acepta el botón postback y el toque aparece al leer la conversación (ver la [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo)). La sección «Botones interactivos (experimental)» se retiró de la interfaz; «Inspeccionar conversación (experimental)» se mantiene como herramienta de solo lectura.


## 17. Pedir que me sigan (follow gate de confianza) — RETIRADA, código inactivo

> **RETIRADA el 2026-10-09.** El resto de esta sección y la [sección 18](#18-adjunto-del-recurso-por-url--retirada-código-inactivo) describen el código **inactivo**, que se conserva para una posible versión futura basada en webhooks.
>
> **Evidencia (en vivo, 2026-10-09).** 41 s después de un toque detectado, el envío del recurso (`POST /<IG_ID>/messages` con `recipient.id`) fue rechazado con HTTP 403, código `10`, subcódigo `2534022` («This message is sent outside of allowed window»; [tabla de errores de Meta](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)). La consulta de seguimiento del perfil respondió código `230` («User consent required»). Ambas indican que Meta **no** cuenta el toque de un botón (en un hilo iniciado por la cuenta con una respuesta privada, visto por una aplicación que solo sondea) como un mensaje de la persona que abra la ventana de 24 h. Consecuencia: quien toca el botón **no recibe nada**. Hipótesis **no verificada**: recibir el toque por webhooks (`messaging_postbacks`) lo cambiaría.
>
> **Qué hace el código hoy** (interruptor `FOLLOW_GATE_AVAILABLE = false` en `src/services/follow-gate-rules.ts`; los servicios aceptan la opción `followGateAvailable` **solo en pruebas**, nunca por variable de entorno):
>
> - API: `POST`/`PUT /api/automations` con `followGateEnabled` distinto de `false`, un `followGateMessage` no vacío o un `followGateButtonTitle` distinto de vacío o «Ya te sigo» → `400 follow_gate_retired`; `resourceAttachmentKind` o `resourceAttachmentUrl` no vacíos → `400 attachment_retired`. Un `PUT` válido **limpia** la configuración guardada (`follow_gate_enabled=0`, mensaje vacío, título «Ya te sigo», sin adjunto). `GET /api/automations` mantiene los campos, siempre como desactivados y vacíos.
> - Encolado: una fila que aún tenga la opción o un adjunto se trata como apagada: el primer mensaje es el normal (texto + botones URL), sin sesión ni botón postback. La Revisión pendiente y las vistas previas de Dry Run muestran ese único mensaje (sin `gatePreview`).
> - Cola: un elemento `QUEUED`/`FAILED_RETRYABLE` congelado con `payload.followGate` pasa a `SKIPPED` con `state_reason_code = follow_gate_retired` **antes** de cualquier llamada al proveedor (mismo patrón que `interactive_mode_retired`). El DTO de la cola muestra ese código en `safeErrorCode` (también para los demás `SKIPPED` con motivo).
> - Motor: en cada tick, las sesiones `AWAITING_TAP` (con o sin toque) pasan a `CANCELLED` con `follow_gate_retired` y un evento `cancelled`, sin llamar a Meta. `COMPLETED`, `FAILED`, `EXPIRED`, `CANCELLED` y `UNKNOWN_OUTCOME` no se tocan (historial). Una sesión `RESOURCE_SENDING` no se cancela: la recuperación de arranque la deja `UNKNOWN_OUTCOME` (`process_interrupted_after_intent`), como siempre.
> - Interfaz: sin casilla, sin adjunto y sin insignias; en «Cola e historial» el bloque «Seguimiento (función retirada · historial)» aparece solo si existe una sesión. Junto a los botones URL: «Para entregar un audio o un video, ponlo en tu página y enlázalo con un botón de enlace.»
> - Esquema: sigue en v14, sin migración; las tablas y columnas se conservan.
>
> **Cómo reactivarla:** implementar la detección del toque por webhooks (servidor accesible desde internet, suscripción a `messaging_postbacks`), verificar en vivo que el envío posterior al toque es aceptado, cambiar `FOLLOW_GATE_AVAILABLE` a `true`, restaurar la interfaz y actualizar esta documentación con la evidencia. No basta con cambiar el interruptor.

Opción normal por automatización, **apagada por defecto**: «Pedir primero que me sigan (sin comprobación)». Es un **sistema de confianza**. Meta no permite comprobar si la persona sigue la cuenta: la consulta de perfil (`is_user_follow_business`) respondió `User consent is required` (código 230) en todas las conversaciones probadas en vivo. La aplicación **no verifica** el seguimiento y nunca dice que lo hizo: solo detecta que la persona tocó el botón.

### Flujo

1. Un comentario coincide con la automatización. El **primer** mensaje privado (respuesta al comentario, `recipient.comment_id`) es el «Mensaje previo» con **un** botón postback (título configurable, por defecto «Ya te sigo»; `payload` generado por el servidor `gate:<automation_id>:0`, el mismo constructor que la fase 0). Sin botones URL. Verificado en vivo: una respuesta privada acepta esta plantilla y el botón aparece dentro de la burbuja.
2. Cuando ese mensaje queda `SENT` (aceptado con ID), en **la misma transacción** se crea una sesión en `gate_sessions` (`AWAITING_TAP`). El IGSID de la persona sale de `recipient_id` de la respuesta del envío (preferido) o de `comments.author_igsid`. Si no hay ninguno, la sesión queda `FAILED` con `igsid_unknown` y el mensaje privado sigue `SENT` (nunca se reenvía).
3. El programador sondea la conversación (solo GET) buscando el toque. Verificado en vivo: el toque aparece al leer la conversación como un mensaje normal del usuario cuyo texto es el título del botón (campos `created_time, from, id, message, to`, sin `payload`), unos 25-35 s después; un texto escrito a mano aparece igual.
4. Con el **primer** toque se envía el **recurso**: la «Respuesta» y los «Botones» URL de la automatización, por IGSID (`POST /{ig-id}/messages` con `recipient.id`). La sesión queda `COMPLETED`.

El texto del primer mensaje, el título y el recurso se **congelan** al encolar (en `queue_items.payload_json`, clave `followGate`) y se copian a la sesión (`button_title`, `resource_payload_json`). Editar o apagar la opción solo afecta a sesiones **nuevas**; una sesión en curso conserva lo que se le prometió a la persona (pausar, archivar o quitar el permiso real sí la cancela, ver abajo).

### Configuración y validación (400 estricto, sin coerción)

| Campo (API) | Regla |
| --- | --- |
| `followGateEnabled` | booleano; omitido en `PUT` = se conserva. Error `follow_gate_invalid`. |
| `followGateMessage` | con la opción activa: 1-640 caracteres tras recortar; variables `{{username}}`, `{{keyword}}`, `{{account}}`, `{{media}}`, `{{comment}}` (como la respuesta). Error `follow_gate_message_invalid`. |
| `followGateButtonTitle` | con la opción activa: 1-20 caracteres, sin enlaces ni saltos de línea. Error `follow_gate_button_title_invalid`. |
| `interactiveMode` / `interactiveTitles` | retirados: solo `none` / `[]` u omitidos. Error `interactive_mode_retired`. |
| `resourceAttachmentKind` / `resourceAttachmentUrl` | adjunto opcional del recurso; ver la [sección 18](#18-adjunto-del-recurso-por-url). Errores `attachment_invalid`, `attachment_url_invalid`, `attachment_requires_follow_gate`. |

El recurso sigue siendo `replyText` (obligatorio) más `buttons` (0-2 botones `web_url`). En Dry Run o sin «Autorizar real», el elemento queda `SIMULATED` con las dos vistas previas (mensaje 1 con botón y mensaje 2 con el recurso): **no se crea sesión ni se llama a Meta**. La Revisión pendiente muestra los dos mensajes (`gatePreview` en el DTO, solo cuando la opción está activa).

### Tablas (v13)

- `gate_sessions`: `gate_session_id`, `account_id`, `automation_id`, `queue_item_id` (único), `comment_id` (único por cuenta), `igsid`, `state`, `gate_sent_at`, `tap_message_id` (único), `tap_at`, `window_expires_at`, `next_poll_at`, `poll_count`, `send_attempts`, `button_title`, `resource_payload_json`, `resource_message_id`, `last_error_code`, fechas. Claves foráneas a la cuenta, el elemento de cola, el comentario y la automatización.
- `gate_events` (solo inserción, triggers): `session_created`, `tap_detected`, `resource_intent_recorded`, `resource_accepted`, `resource_rejected`, `resource_ambiguous`, `expired`, `cancelled`, `poll_error`, con `message_id`, `safe_error_code` y `details_json` acotado.

### Estados

| Estado | Significado | Siguiente |
| --- | --- | --- |
| `AWAITING_TAP` | Esperando el toque (o, si `tap_at` ya existe, toque recibido y envío pendiente por límite de uso o por una guarda transitoria). | `RESOURCE_SENDING`, `EXPIRED`, `CANCELLED`, `FAILED` |
| `RESOURCE_SENDING` | Intención durable registrada; POST en curso. | `COMPLETED`, `FAILED`, `UNKNOWN_OUTCOME`, `AWAITING_TAP` (solo por límite de uso), `EXPIRED` |
| `COMPLETED` | Meta aceptó el recurso (con ID). | — |
| `EXPIRED` | Sin toque en 7 días (`gate_no_tap_7d`) o pasaron 24 h desde el toque (`resource_window_elapsed`). Nunca se envía. | — |
| `CANCELLED` | La automatización se pausó, archivó o perdió «Autorizar real» antes del envío (`automation_inactive`). | — |
| `FAILED` | Rechazo definitivo de Meta (sin reintento) o `igsid_unknown`. | — |
| `UNKNOWN_OUTCOME` | Timeout, error de red, 5xx, respuesta sin ID o reinicio con el envío en curso. **Nunca** se reintenta; revise en Instagram. | — |

### Sondeo, límites y ventanas

- Lo ejecuta el tick del Monitoreo (cada 60 s) después de la respuesta privada y la pública; con el Monitoreo apagado, en Dry Run o con la cuenta pausada **no se hace nada**. Por eso la resolución real es la del tick: el recurso suele llegar entre 30 s y 2 minutos después del toque.
- Calendario por sesión: primer sondeo 20 s después del mensaje con botón, luego cada 30 s durante los primeros 10 minutos, cada 2 minutos hasta las 2 horas y cada 10 minutos hasta que vence (7 días sin toque).
- Como máximo **10 sesiones por tick**, en secuencia, con 0,5 s entre llamadas a Meta. Cada sondeo: buscar la conversación (`GET /{ig-id}/conversations?platform=instagram&user_id=<IGSID>`), listar los IDs de mensajes (`GET /{conversación}?fields=messages`) y leer detalles del más nuevo al más viejo, **como máximo 5**, deteniéndose en el primero anterior al mensaje con botón. Los IDs se validan como opacos; se ignoran los mensajes de la propia cuenta.
- Coincidencia: texto del mensaje del usuario normalizado (NFC, minúsculas, espacios colapsados, sin puntuación/emoji al inicio o al final) igual al título normalizado. Se toma el primer toque; los posteriores se ignoran (`tap_message_id` único).
- Ventana: el recurso solo puede enviarse dentro de las **24 h** posteriores al toque (la ventana de mensajería de Meta cuenta desde el mensaje del usuario).
- Un error de sondeo (límite de uso, red) **no cambia el estado**: se registra `poll_error` y el siguiente sondeo espera al menos 2 minutos.

### Envío del recurso y fallos

Antes del POST se revalida en SQL: Dry Run apagado, automatización existente, activa, no archivada y con «Autorizar real», cuenta y conexión válidas y monitoreadas, sin retención de envíos, ningún otro envío en curso de la cuenta (privado, público o de otro recurso) y ventana vigente. La retención heredada se aplica igual que en los demás envíos. Luego se confirma la intención (`RESOURCE_SENDING` + `resource_intent_recorded`) y recién entonces se hace el POST:

```json
{ "recipient": { "id": "<IGSID>" }, "message": { "text": "…" } }
{ "recipient": { "id": "<IGSID>" }, "message": { "attachment": { "type": "template", "payload": { "template_type": "button", "text": "…", "buttons": [ { "type": "web_url", "title": "…", "url": "https://…" } ] } } } }
```

Resultados: aceptado con ID → `COMPLETED`; rechazo definitivo → `FAILED` sin reintento; límite de uso (HTTP 429 o códigos 4, 17, 32, 613) → se reintenta **solo el envío** (el toque ya quedó registrado) como máximo 3 intentos, respetando `Retry-After` y sin salir de la ventana; ambiguo → `UNKNOWN_OUTCOME`. Al arrancar, toda sesión `RESOURCE_SENDING` pasa a `UNKNOWN_OUTCOME` (`process_interrupted_after_intent`). No hay botón de reintento manual. No se hace lectura de comprobación del recurso.

Documentación de Meta: [Instagram Messaging API (Send API)](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api) — `POST /<IG_ID>/messages` con `recipient.id` (IGSID), respuesta `{ recipient_id, message_id }` y ventana de 24 h; [Button Template](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/button-template) — `template_type: "button"`, 1-3 botones `web_url`/`postback`, texto hasta 640 caracteres.

### API y vista

- `GET /api/automations`: `followGateEnabled`, `followGateMessage`, `followGateButtonTitle`.
- `GET /api/queue`: `payload.followGate` (`buttonTitle`, `resource { text, buttons }`) y `followGate` (sesión: `state`, `buttonTitle`, `gateSentAt`, `tapAt`, `windowExpiresAt`, `nextPollAt`, `pollCount`, `resourceMessageId`, `lastErrorCode`, o `null`). El IGSID nunca se expone.
- `GET /api/queue/:id/attempts`: `gateEvents` (`type`, `at`, `safeErrorCode`, `details` acotado).
- Interfaz: casilla en el formulario y en el diálogo de edición (mensaje previo, título, adjunto opcional, nota de la limitación y vista previa de los mensajes). Insignia «Pide seguir (sin comprobar)». En «Cola e historial» → «Ver», bloque «Seguimiento» con el estado en español, fechas, eventos y pistas de error.

### Qué NO está verificado

- La aplicación **no comprueba el seguimiento**; no hay forma conocida de hacerlo hoy.
- El envío por IGSID (`recipient.id`) del recurso **no se probó en vivo** desde esta aplicación; las formas JSON siguen la documentación de Meta y están cubiertas por pruebas automáticas con un proveedor simulado.
- El sondeo de conversaciones a escala (muchas sesiones simultáneas, límites de uso reales de Meta) no se midió. Si la persona escribe más de 5 mensajes después de tocar el botón antes del siguiente sondeo, el toque puede quedar fuera de los 5 detalles leídos y no detectarse.
- Que `from.id` del comentario sea el mismo IGSID que `recipient_id` no está confirmado; por eso se prefiere `recipient_id`.

## 18. Adjunto del recurso por URL — RETIRADA, código inactivo

> **RETIRADA el 2026-10-09** junto con la [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo): el adjunto solo se enviaba después del toque, y ese envío es el que Meta rechaza (código 10, subcódigo 2534022). La API responde `400 attachment_retired` y una fila con adjunto guardado se trata como «sin adjunto». Lo que sigue describe el código inactivo.

Opcional, solo con «Pedir primero que me sigan» activo: un medio (imagen, audio, video o PDF) que se envía **como mensaje aparte, antes** del texto del recurso. Sin adjunto, todo funciona exactamente como en la [sección 17](#17-pedir-que-me-sigan-follow-gate-de-confianza--retirada-código-inactivo) (mismo payload, mismos eventos; no se escriben `gate_part_events`).

### Por qué dos mensajes y por qué una URL

- Según la documentación de Meta, en un mensaje de seguimiento (`POST /<IG_ID>/messages` con `recipient.id`, dentro de las 24 h posteriores al mensaje de la persona) un adjunto va en `message.attachment = { type, payload: { url } }`. Los botones solo viajan en plantillas, así que **adjunto y botones en un mismo mensaje no está documentado**: se envían dos mensajes seguidos, (1) el adjunto y (2) el texto con los botones (la plantilla de botones de siempre).
- Meta descarga el archivo desde **sus** servidores: la URL debe ser pública y HTTPS. Esta aplicación es local, no aloja archivos y **nunca descarga** la URL (no comprueba formato ni tamaño).
- Formatos y tamaños según Meta (consultado el 2026-10-08): imagen png o jpeg, 8 MB; audio aac, m4a, wav o mp4, 25 MB; video mp4, ogg, avi, mov o webm, 25 MB; archivo: solo PDF, 25 MB. mp3 y gif **no** están en la lista documentada: no se bloquean, pero la interfaz muestra un aviso.
- Fuentes: [Instagram Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api) y [Send a message](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/send-message).

```json
{ "recipient": { "id": "<IGSID>" }, "message": { "attachment": { "type": "audio", "payload": { "url": "https://…/clase.m4a" } } } }
```

(`type` es `image`, `audio`, `video` o `file`; el segundo mensaje es exactamente el JSON de la sección 17.)

### Configuración y validación (400 estricto)

| Campo (API) | Regla | Error |
| --- | --- | --- |
| `resourceAttachmentKind` | `''` (sin adjunto), `image`, `audio`, `video` o `file` (PDF). Omitido en `PUT` = se conserva. | `attachment_invalid` |
| `resourceAttachmentUrl` | obligatoria con un tipo; `https:`, hasta 2048 caracteres, sin usuario ni contraseña, sin espacios; el host no puede ser `localhost`, una IP (v4 en cualquier forma o v6), un nombre sin punto ni terminar en `.local`, `.localhost`, `.lan`, `.home`, `.internal`, `.intranet`, `.corp`, `.arpa`, `.test` o `.invalid`. Una URL sin tipo es `attachment_invalid`. | `attachment_url_invalid` |
| (requisito) | un adjunto enviado en la solicitud exige `followGateEnabled` efectivo. Con la opción apagada, un adjunto ya guardado se conserva como borrador y no se usa. | `attachment_requires_follow_gate` |

Al encolar, el adjunto se congela en `payload.followGate.attachment` (solo si existe) y, al crear la sesión, en `gate_sessions.resource_attachment_kind/url`. Editar la automatización solo afecta a sesiones nuevas.

### Secuencia y estados por parte

1. Toque detectado (igual que la sección 17).
2. **Parte `attachment`:** intención durable (`RESOURCE_SENDING` + `resource_intent_recorded` con `details.part` + `gate_part_events` `intent_recorded`), con las mismas guardas SQL más «el adjunto no tiene resultado final»; luego el POST.
3. Resultado del adjunto: aceptado con ID → `accepted` y la sesión vuelve a `AWAITING_TAP` (toque conservado); rechazo definitivo → `rejected` + `skipped` (`attachment_failed`) y se sigue con el texto; límite de uso → `rejected` con `retryAt`, se reintenta **solo el adjunto** (máximo 3 intentos de esa parte, `Retry-After`, dentro de la ventana; si se agotan se trata como rechazo y se omite); ambiguo → `ambiguous`, sesión `UNKNOWN_OUTCOME` y el texto **nunca** se envía.
4. Espera de al menos **1 s** (`GATE_PART_SPACING_MS`, medido con el reloj del motor desde el resultado del adjunto). Si no pasó, la sesión queda con `next_poll_at` = ese momento y el texto sale en un tick posterior.
5. **Parte `text`:** intención durable (la SQL exige adjunto `accepted` o `skipped` y texto sin `accepted`/`ambiguous`) y POST de la plantilla de siempre. Aceptado → `COMPLETED` (con `last_error_code = attachment_failed` si el adjunto se omitió); rechazo → `FAILED`; límite de uso → se reintenta solo el texto (3 intentos propios); ambiguo → `UNKNOWN_OUTCOME`. Un fallo del texto **nunca** reenvía el adjunto.

`gate_part_events` (solo inserción): `part` (`attachment`/`text`), `event_type` (`intent_recorded`, `accepted`, `rejected`, `ambiguous`, `skipped`), `event_at`, `message_id`, `safe_error_code`, `details_json`; índice único: un `accepted` por (sesión, parte). Al arrancar, una sesión `RESOURCE_SENDING` pasa a `UNKNOWN_OUTCOME` y la parte que tenía intención sin resultado recibe `ambiguous` (`process_interrupted_after_intent`). Expiración (24 h), cancelación por automatización inactiva, Dry Run y aislamiento por cuenta no cambian.

### API y vista

- `GET /api/automations`: `resourceAttachmentKind`, `resourceAttachmentUrl`.
- `GET /api/queue`: `payload.followGate.attachment` (si existe) y, en sesiones con adjunto, `followGate.attachment` y `followGate.parts { attachment, text }` con `state` (`pending`, `sending`, `rejected`, `accepted`, `skipped`, `ambiguous`), `safeErrorCode` y `attempts`. Las sesiones sin adjunto conservan exactamente sus claves.
- `GET /api/queue/:id/attempts`: `gatePartEvents` (`part`, `type`, `at`, `safeErrorCode`; sin IDs de mensaje).
- Revisión pendiente: `gatePreview.attachment` cuando hay adjunto.
- Interfaz: «Adjunto del recurso (opcional)» (tipo + URL, ayuda y avisos de mp3/gif o de enlaces para compartir), vista previa «Mensaje 1: se enviaría un audio (host · archivo)» y «Mensaje 2 · texto + botones», insignia «Adjunto: audio/imagen/video/PDF», y en «Seguimiento» el estado de cada parte con la pista «Meta rechazó el adjunto; se envió solo el texto».

### Qué NO está verificado

- Nada de esto se probó en vivo contra Meta: JSON y reglas vienen de la documentación y de pruebas con un proveedor simulado.
- Cómo se ve un audio en Instagram (reproductor o nota de voz), si Meta acepta mp3 o gif, el límite real de tiempo de descarga de Meta (una descarga lenta puede terminar en el timeout de 10 s de la aplicación y quedar `UNKNOWN_OUTCOME`), y si «Your app user must own any media» limita URLs de terceros.
- Que los dos mensajes lleguen en orden: Meta no documenta una garantía de orden; la aplicación solo garantiza el orden de envío y la separación mínima de 1 s.
- Adjuntos dentro de la respuesta privada al comentario: no documentado, **fuera de alcance** (allí solo texto y la plantilla del botón).


## 19. Moderación de comentarios

Marca comentarios ofensivos o spam de las publicaciones de la cuenta según reglas locales y **sugiere** qué hacer con ellos: la persona decide si ocultarlos, mostrarlos, borrarlos o descartarlos. Lo único automático es **ocultar** (opcional, confirmado y solo en modo real): **nada se borra nunca automáticamente**. En Dry Run todas las acciones se simulan.

### Categorías y umbrales

Un comentario recibe como máximo una marca; si coinciden varias reglas gana la de mayor prioridad (en este orden) y todas las razones quedan en `reasons_json`. Los comentarios de la propia cuenta nunca se marcan; las respuestas dentro de un hilo sí.

| Categoría | Regla |
| --- | --- |
| `blocked_term` | Contiene una palabra o frase de la lista de la cuenta (sin distinguir mayúsculas ni tildes, por palabra completa; máximo 200 términos de 1 a 60 caracteres). |
| `spam_link` | Contiene un enlace (`http://`, `https://`, `www.`, `bit.ly`, `t.me/`, `wa.me/`). |
| `spam_phone` | Secuencia tipo teléfono de **7 o más dígitos** (admite espacios, guiones y `+`). |
| `spam_mentions` | **3 o más** `@menciones` distintas. |
| `spam_emoji` | El **mismo emoji 6 o más veces**, o un comentario hecho **solo de emojis con 10 o más**. Desactivado por defecto. |

El escaneo (Monitoreo y Revisión pendiente) solo clasifica e inserta marcas `PENDING` (`INSERT OR IGNORE`, una por comentario) cuando la moderación de la cuenta está activa; **nunca** oculta ni borra (el escáner no tiene acceso a esas operaciones del proveedor).

### Estados y transiciones

| Desde | Acción | Hacia |
| --- | --- | --- |
| `PENDING`, `VISIBLE`, `FAILED`, `SIMULATED` | ocultar (`hide`) | `HIDE_INTENT` → `HIDDEN` |
| `HIDDEN`, `FAILED` | mostrar (`unhide`) | `UNHIDE_INTENT` → `VISIBLE` |
| `PENDING`, `HIDDEN`, `VISIBLE`, `FAILED`, `SIMULATED` | borrar (`delete`, confirmado) | `DELETE_INTENT` → `DELETED` |
| `PENDING`, `FAILED`, `SIMULATED` | descartar (`dismiss`, individual o masivo) | `DISMISSED` |
| `UNKNOWN_OUTCOME` | descartar **solo individual** | `DISMISSED` |

- **Dry Run:** cualquier acción permitida deja la marca en `SIMULATED` (con `last_action`) y registra `outcome = 'simulated'`, sin llamar a Meta. Desde `SIMULATED` solo se permite ocultar, borrar o descartar: **nunca mostrar**, porque nada real se ocultó.
- **Resultado de Meta:** aceptado → `HIDDEN` / `VISIBLE` / `DELETED`; rechazado → `FAILED` con código seguro; ambiguo (5xx, timeout, error de red, 2xx sin `success: true`) → `UNKNOWN_OUTCOME`. Si el proveedor **lanza una excepción** después de registrar la intención, la marca queda `UNKNOWN_OUTCOME` con `moderation_ambiguous` (y una fila `ambiguous`).
- **`UNKNOWN_OUTCOME` nunca se reintenta.** La persona revisa el comentario en Instagram y lo resuelve con «Descartar» uno por uno; la acción masiva no lo acepta (decisión consciente, caso por caso).
- `DELETED`, `DISMISSED` y los `*_INTENT` no admiten acciones. La interfaz solo muestra los botones de las acciones permitidas para el estado de cada marca (las mismas tablas, en `app/moderation-labels.ts`).
- **Descartar queda auditado:** nunca llama a Meta, pero cada descarte (individual o masivo) escribe una fila en `moderation_actions` con `action = 'dismiss'`, `actor = 'operator'`, `outcome = 'accepted'` y `mode` según Dry Run (`dry_run` o `real`), en la misma transacción que cambia el estado. Un descarte rechazado no escribe nada.
- **Intención durable con estado esperado:** en modo real, una transacción `BEGIN IMMEDIATE` comprueba Dry Run desactivado, cuenta y conexión válidas y sin retención (`account_send_holds`), y pasa la marca a `*_INTENT` **solo si sigue en un estado permitido** (`AND state IN (…)`); si no cambia exactamente una fila, se revierte y no se llama a Meta. El resultado se guarda **solo si la marca sigue en su estado de intención** (`AND state = '<X>_INTENT'`); si algo la movió entretanto, la marca no cambia y el resultado de Meta queda solo en `moderation_actions`.
- **Recuperación al arrancar:** el Scheduler (`createScheduler`, usado por `server.ts`) pasa toda marca `*_INTENT` a `UNKNOWN_OUTCOME` al iniciar, junto a la recuperación de la cola.

### Ocultar automáticamente

- Opcional por cuenta, con categorías permitidas: las cinco de reglas y, si la persona las marca, `ai_insult`, `ai_hate` y `ai_spam` (la interfaz avisa «IA puede equivocarse»). **`ai_complaint` nunca:** la API rechaza `ai_complaint` (`invalid_request`) y el selector del auto-ocultar lo excluye en SQL aunque estuviera guardado. Activarlo **o agregar una categoría** exige `confirmed: true`; guardar otros cambios o quitar categorías con el auto-ocultar ya activo no lo exige.
- **El auto-ocultar no es retroactivo:** al activarlo se guarda `auto_hide_since` (momento de activación; se conserva mientras siga activo y vuelve a `NULL` al apagarlo) y solo se toman marcas cuyo **comentario** se publicó después (`comments.created_at >= auto_hide_since`, comparado con `julianday`; el `+0000` de Meta se normaliza). Se mira la fecha del comentario, no la de la marca: una revisión con IA de hoy sobre comentarios viejos crea marcas nuevas, pero esos comentarios siguen como sugerencias. Una marca sin comentario guardado nunca se oculta sola. Vale igual para marcas de reglas y de IA.
- Se ejecuta en cada ciclo del Monitoreo (con el Monitoreo encendido), **solo en modo real** (en Dry Run no hace nada, ni simula), **solo `hide`** (nunca borra), como máximo **una marca por ciclo** y con al menos **10 s** entre acciones automáticas (`app_state.moderation_last_auto_at`).
- Elige la marca `PENDING` más antigua cuya categoría está permitida (filtrado en SQL, así una categoría no permitida no bloquea a las demás), de una cuenta con moderación y auto-ocultar activos, válida, **con el Monitoreo de la cuenta en marcha** (`social_accounts.monitoring_paused = 0`: una cuenta pausada nunca se oculta sola), con conexión válida y sin retención. Las acciones quedan con `actor = 'auto'`.

### Llamadas a Meta y permisos

- Ocultar / mostrar: `POST /{comment-id}` con cuerpo JSON `{ "hide": true }` o `{ "hide": false }`. Borrar: `DELETE /{comment-id}`. Ambas responden `{ "success": true }`.
- Host según el tipo de conexión: `graph.instagram.com` (Instagram Login, permiso `instagram_business_manage_comments`) o `graph.facebook.com` (Facebook Login, permiso `instagram_manage_comments`).
- Antes de llamar se comprueba que el comentario pertenece a la cuenta en la base local; si no, se rechaza (`comment_not_owned`) sin llamada HTTP.
- Errores: 429 o códigos 4, 17, 32, 613 → `moderation_rate_limited`; códigos 3, 10, 102 o 190, o de la familia 200 (200-299) → `moderation_permission_denied`; 404 o código 100 → `moderation_not_found`; otros 4xx → `moderation_rejected`.
- **Limitación de Meta:** no se pueden ocultar ni borrar comentarios de transmisiones en vivo (ni sus respuestas).

### API de moderación

Todas exigen `accountId` y comprueban que la marca pertenece a esa cuenta; las escrituras pasan por las guardas de origen, CSRF y JSON. `confirmed` se acepta solo si es exactamente `true` (`"no"`, `1` o `"true"` se rechazan).

- `GET /api/moderation/settings?accountId=` → configuración (valores por defecto si no hay fila).
- `PUT /api/moderation/settings` `{ accountId, enabled, blockedTerms[], detectLinks, detectPhones, detectMentions, detectEmoji, autoHideEnabled, autoHideCategories[], confirmed? }`.
- `GET /api/moderation/flags?accountId=&state=&source=&limit=&offset=` → `{ items, total }` (límite por defecto 50, máximo 100; `state` debe ser un estado conocido u omitirse para «Todos»; `source` es `rules` o `ai`, u omitido para «Todas»). Cada elemento incluye `source`.
- `POST /api/moderation/flags/{flagId}/hide`, `/unhide`, `/dismiss` `{ accountId }` y `/delete` `{ accountId, confirmed: true }`.
- `POST /api/moderation/flags/bulk` `{ accountId, flagIds, action: 'hide' | 'unhide' | 'delete' | 'dismiss', confirmed? }`:
  - `flagIds`: de 1 a 100 IDs **únicos**. `delete` exige `confirmed: true`.
  - **Todo o nada en la pertenencia:** si un solo ID no existe o es de otra cuenta → 404 `not_found` y no se actúa sobre ninguno.
  - Cada marca pasa por la misma lógica individual (su propia intención y filas de auditoría). Un `invalid_state` en una marca se informa y el lote **continúa**.
  - En modo real hay **1 s** entre llamadas a Meta. Un `moderation_rate_limited` **detiene el lote**, y también lo detiene `account_invalid_or_held` (cuenta o conexión no válida, o cuenta retenida) o cualquier otro rechazo (`operation_rejected`); las marcas restantes se informan con `error: 'not_attempted'`. En Dry Run todas quedan `SIMULATED` sin llamadas.
  - Respuesta: `{ "results": [{ "flagId", "state", "safeErrorCode"?, "error"? }] }` (`state` es el estado actual de la marca; `error` es `invalid_state`, `not_attempted`, `account_invalid_or_held` u `operation_rejected`). La interfaz resume el resultado (p. ej. «3 ocultados, 1 sin cambios»).

Códigos de error: 400 `confirmation_required`, `blocked_term_invalid` o `invalid_request` (categorías no válidas, IDs repetidos o fuera de rango, acción desconocida); 404 `not_found` (marca inexistente o de otra cuenta); 409 `invalid_state` (transición no permitida), `account_invalid_or_held` (cuenta o conexión no válida, o cuenta retenida) y `operation_rejected` (otro rechazo por estado o seguridad).

### Esquema (v16, ampliado en v17 y v18)

| Tabla | Columnas |
| --- | --- |
| `moderation_settings` | `account_id` (PK), `enabled`, `blocked_terms_json`, `detect_links`, `detect_phones`, `detect_mentions`, `detect_emoji`, `auto_hide_enabled`, `auto_hide_categories_json`, `auto_hide_since` (inicio del auto-ocultar; `NULL` si está apagado), `version` (sube en cada guardado), `updated_at`. Sin fila = valores por defecto (desactivada; enlaces, teléfonos y menciones activos; emojis inactivo). |
| `moderation_flags` | `flag_id` (PK), `account_id`, `media_id`, `comment_id`, `category` (cinco de reglas + `ai_insult`/`ai_hate`/`ai_spam`/`ai_complaint` desde v17), `source` (`rules` o `ai`), `reasons_json`, `state`, `last_action`, `safe_error_code`, `settings_version`, `created_at`, `updated_at`; `UNIQUE(account_id, comment_id)`. |
| `moderation_actions` | `action_id`, `flag_id`, `account_id`, `comment_id`, `action` (`hide`/`unhide`/`delete`/`dismiss`), `actor` (`operator`/`auto`), `mode` (`dry_run`/`real`), `outcome` (`simulated`/`intent`/`accepted`/`rejected`/`ambiguous`), `safe_error_code`, `created_at`. **Solo inserción:** triggers que abortan UPDATE y DELETE. |
| `moderation_ai_settings` | `account_id` (PK), `engine` (`off` por defecto / `gemini` / `local`), `model` (modelo de Gemini), `local_model` (v18: `qwen2.5-1.5b` / `qwen3-4b`; `NULL` = el predeterminado), `api_key_nonce`, `api_key_ciphertext`, `api_key_tag` (key cifrada con la bóveda, contexto `moderation-ai:gemini:<accountId>`), `api_key_hint` (`…` + últimos 4 caracteres), `consent_at`, `updated_at`. |
| `moderation_ai_jobs` | `job_id` (PK), `account_id`, `state` (`running`/`completed`/`failed`/`stopped`), `review_window` (`24h`/`3d`/`7d`/`30d`), `chunks_total`, `chunks_done`, `chunks_failed`, `comments_total`, `comments_sent`, `truncated`, `flagged`, `invalid_output`, `error_code`, `started_at`, `finished_at`. Índice único parcial `(account_id) WHERE state = 'running'`. |

### Revisión con IA

Botón «Revisar comentarios negativos» en la barra superior de la sección «Moderación»; el motor, la key y los modelos se eligen en la pestaña «IA» del panel izquierdo, y el periodo, el progreso y el resumen aparecen sobre la lista de comentarios marcados. **Desactivada por defecto.** Solo **crea marcas**: nunca llama a Meta; ocultar, borrar o descartar siguen siendo las acciones de arriba.

- **Motores:** `off` (por defecto), `gemini` (API key gratuita de Google AI Studio de la persona) y `local` (modelo que corre dentro de este proceso; ver [Modelo local](#modelo-local)). Cambiar de motor conserva la key y el modelo de Gemini.
- **Privacidad:** antes de activar Gemini la interfaz muestra este aviso, que también queda junto al selector (salvo con el modelo local, que muestra «Todo se procesa en este equipo; ningún comentario sale de él.»), y la API exige `confirmed: true` (estricto) la primera vez: «Con la API gratuita, Google puede usar el contenido enviado para mejorar sus productos. Los comentarios de sus clientes saldrán de este equipo. Para que nada salga del equipo use el modelo local.» Se guarda `consent_at`.
- **API key:** se guarda **cifrada** con la bóveda (AES-256-GCM) y **nunca** sale: ningún endpoint la devuelve (solo `hasApiKey` y `apiKeyHint` como `…abcd`), no se registra y los errores solo llevan códigos seguros (el texto de Google se descarta). `listEncryptedCredentials` la incluye, así que sin `vault.key` el arranque falla en lugar de regenerarla.
- **Gemini:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (host fijo), key en el header `x-goog-api-key` (nunca en la URL), `systemInstruction`, `safetySettings` en `BLOCK_NONE` (lo que se clasifica son justamente insultos y odio), `generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0 }`. Modelos permitidos: `gemini-2.5-flash-lite` (por defecto) y `gemini-2.5-flash` (allowlist + regex `^gemini-[0-9a-z.\-]+$`). Timeout 20 s, respuesta de máximo 256 KB, `redirect: 'error'`. La referencia actual de Google marca `responseSchema` como obsoleto (sigue aceptado); cambiar a `responseJsonSchema` o `responseFormat` solo toca `responseSchema()` y `requestBody()`.
- **Lotes:** el servidor envía `{ "c1": "<texto>", … }` y el modelo devuelve `{ "c1": "<categoría>", … }`. Las claves son **alias del lote** (`c1`…`c40`), no el ID de Meta: el modelo no tiene que copiar IDs largos y el ID real no sale del equipo. El esquema de respuesta exige exactamente esas claves y una de las cinco categorías.
- **Categorías:** `ai_insult` (insulto/acoso a una persona), `ai_hate` (odio/discriminación), `ai_spam` (spam/estafa), `ai_complaint` (queja legítima: se muestra para revisar con el aviso «Queja legítima: conviene responder, no ocultar» y **nunca** se oculta sola; las demás categorías IA solo se ocultan solas si se marcaron en el auto-ocultar y si el comentario se publicó después de activarlo) y `neutral` (sin marca). Las marcas se crean con `INSERT OR IGNORE`, `source = 'ai'`, estado `PENDING` y `reasons_json = ["IA: <etiqueta>"]`.
- **Inyección de instrucciones:** los textos son **datos**. Viajan solo como valores de cadena JSON (`JSON.stringify` escapa comillas y saltos: un comentario no puede cerrar el objeto ni agregar claves), la instrucción de sistema ordena ignorar cualquier instrucción dentro de un comentario y la salida se valida: claves fuera del lote, categorías desconocidas o valores no textuales se ignoran (nunca se inventa una marca) y se cuentan como `invalidOutput`; una respuesta que no es un objeto JSON cuenta todo el lote como inválido. El prompt (`src/services/moderation-ai-prompt.ts`) distingue queja de insulto con jerga y groserías de Colombia, México y Argentina, con 8 ejemplos.
- **Alcance de un trabajo:** comentarios de esa cuenta en la ventana elegida (`24h`, `3d`, `7d`, `30d`), con texto, que **no** son de la propia cuenta y que **no tienen ninguna marca** (de cualquier origen y estado). La ventana, la exclusión de marcados y el orden se resuelven en SQL y las filas se leen en flujo (solo se guardan en memoria las primeras 2000). Los más recientes primero; lotes de **40**; máximo **2000** por trabajo (si hay más se informa `truncated: true` y `commentsTotal`); cada texto se corta a **500** caracteres. El tamaño del lote y la pausa entre lotes son propiedades del motor (`chunkSize`, `spacingMs`): Gemini usa lotes de **40** con al menos **4 s** entre uno y otro (límite gratuito); el modelo local usa lotes de **10** sin pausa. Los comentarios que quedaron `neutral` vuelven a entrar en la siguiente revisión (no se guarda un registro de «ya revisado»).
- **Errores:** 429 / `RESOURCE_EXHAUSTED` → espera `retryDelay` de `error.details[]` (`google.rpc.RetryInfo`) o `retry-after` (tope 60 s), como máximo 3 reintentos por lote y luego el trabajo termina `failed` con `ai_rate_limited`; 401/403, o 400 con `reason: API_KEY_INVALID` en `error.details[]` → `ai_auth_failed` sin reintento (trabajo `failed`); cualquier otro 400 u otro 4xx → `ai_request_rejected` (trabajo `failed`, sin reintento); 5xx, timeout o error de red → un reintento y luego ese lote cuenta como fallido (`chunksFailed`, código `ai_unavailable`) y se sigue con el siguiente.
- **Un trabajo por cuenta:** un segundo inicio responde 409 `ai_job_running`. «Detener» aborta la solicitud en curso y el trabajo termina `stopped` antes del siguiente lote. **Apagar la IA** (`engine: 'off'`) o **borrar la key** (`apiKey: ''`) detiene igual el trabajo en curso, antes de guardar el cambio; la interfaz además deshabilita el selector de motor y «Borrar key» mientras corre una revisión («Detenga la revisión para cambiar el motor.»). Al arrancar el servidor, los trabajos `running` pasan a `stopped` con `ai_interrupted`.

API (las escrituras pasan por origen + CSRF + JSON; todas exigen `accountId`, que debe existir):

- `GET /api/moderation/ai-settings?accountId=` → `{ engine, model, localModel, localModelInstalled, hasApiKey, apiKeyHint, consentAt, availableModels }`.
- `PUT /api/moderation/ai-settings` `{ accountId, engine, model?, apiKey?, confirmed? }`: `apiKey` es de solo escritura (omitido conserva la guardada, `''` la borra; formato `[A-Za-z0-9_-]{20,128}` o 400 `ai_key_invalid`); pasar a `gemini` sin consentimiento previo exige `confirmed: true` (400 `confirmation_required`); con `engine: 'local'`, `model` es un id local (`qwen2.5-1.5b` o `qwen3-4b`; se guarda en `local_model`) y el archivo debe estar instalado (409 `ai_model_missing`), sin consentimiento (nada sale del equipo); con otro motor, `model` es un modelo de Gemini; modelo fuera de la lista → 400 `ai_model_invalid`.
- `POST /api/moderation/ai-settings/test` `{ accountId }` → envía **un** comentario sintético («Gracias por la info!») y responde `{ ok: true }` o `{ ok: false, errorCode }`. Exige motor `gemini` con consentimiento registrado (si no, 409 `ai_disabled`) y una key guardada (si no, 409 `ai_key_missing`).
- `POST /api/moderation/ai-review` `{ accountId, window }` → 202 con el estado del trabajo; 409 `ai_disabled` (motor `off`), `ai_key_missing`, `ai_model_missing` (motor local sin el archivo), `ai_job_running`; 400 `invalid_request` (ventana desconocida). Con el motor local, si el runtime o el modelo no cargan, el trabajo termina `failed` con `ai_local_unavailable`.
- `GET /api/moderation/ai-review?accountId=` → `{ jobId, state, window, progress: { chunksDone, chunksTotal, commentsSent, flagged, invalidOutput, chunksFailed, commentsTotal, truncated }, errorCode?, startedAt, finishedAt? }` del último trabajo, o `{ state: 'idle' }`.
- `POST /api/moderation/ai-review/stop` `{ accountId }` → estado actual; 409 `ai_job_not_running` si no hay trabajo en curso.

### Modelo local

Clasificador 100 % privado y gratuito: corre **dentro del proceso del servidor**, sin servicios externos. Solo la descarga del modelo usa internet (una vez). Desactivado por defecto, como toda la revisión con IA.

- **Runtime:** [`node-llama-cpp`](https://node-llama-cpp.withcat.ai/) `3.21.1` (MIT, versión exacta en `dependencies`). Trae binarios **precompilados** por plataforma como `optionalDependencies` (`@node-llama-cpp/win-x64`, `linux-x64`, `mac-arm64-metal`, …): `npm install` no compila nada. Se importa con `import()` dinámico la primera vez que el motor local clasifica, así que la aplicación arranca aunque el binario nativo no cargue; ese fallo, igual que un archivo dañado o falta de memoria, termina el trabajo con `ai_local_unavailable` y la causa va al registro del servidor **sin rutas ni tokens**. `getLlama({ gpu: false, build: 'never', logLevel: 'error', maxThreads })`: solo CPU y nunca intenta compilar ni descargar llama.cpp.
- **Modelos** (GGUF oficiales de Qwen, Q4_K_M, URL fijada a un commit; tamaño y SHA-256 tomados de `https://huggingface.co/api/models/<repo>/tree/main`, campo `lfs.oid`):

| id | Archivo | Repositorio @ commit | Bytes | SHA-256 | Licencia |
| --- | --- | --- | --- | --- | --- |
| `qwen2.5-1.5b` (por defecto) | `qwen2.5-1.5b-instruct-q4_k_m.gguf` | `Qwen/Qwen2.5-1.5B-Instruct-GGUF` @ `91cad51170dc346986eccefdc2dd33a9da36ead9` | 1117320736 (~1,1 GB) | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` | Apache-2.0 |
| `qwen3-4b` | `Qwen3-4B-Q4_K_M.gguf` | `Qwen/Qwen3-4B-GGUF` @ `bc640142c66e1fdd12af0bd68f40445458f3869b` | 2497280256 (~2,5 GB) | `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5` | Apache-2.0 |

  Qwen2.5-3B-Instruct **no** se ofrece: su licencia es la «Qwen Research License» (solo uso no comercial), incompatible con el uso en un negocio. Qwen3-4B (Apache-2.0) es la opción grande; responde sin «pensar» (`budgets.thoughtTokens: 0`).
- **Dónde se guardan:** `<LOCAL_SOCIAL_DATA_DIR>/models/` (en Windows `%LOCALAPPDATA%\SocialDesk\data\models`): nunca dentro de la carpeta del programa, así que sobreviven a reinstalar y actualizar. Desinstalar no los borra.
- **Descarga** (`src/services/moderation-ai-local-model.ts`): una sola a la vez para toda la instalación. Comprueba antes el espacio libre con `fs.statfs` (faltan bytes del modelo + 500 MB → 409 `insufficient_disk`). Escribe en `<archivo>.part` en flujo (memoria acotada), sigue las redirecciones **a mano** (`redirect: 'manual'`, máximo 5) y solo hacia `https` en `huggingface.co`, `*.hf.co` o `cdn-lfs*.huggingface.co` (otro host o `http` → `download_host_rejected`, sin contactarlo). Si ya hay un `.part`, reanuda con `Range: bytes=<n>-` (si el servidor responde 200 en vez de 206, empieza de cero). Al terminar verifica **tamaño exacto y SHA-256** y solo entonces renombra el archivo (atómico); si no coinciden borra el `.part` (`checksum_mismatch`). Timeouts: 30 s hasta la respuesta y 60 s sin datos (`download_timeout`); error de red → `download_failed`; respuesta HTTP no esperada → `download_http_error`; disco lleno al escribir → `insufficient_disk`. El estado se guarda en `models/download-state.json`; al arrancar, una descarga `running` pasa a `cancelled` y el `.part` queda para reanudar. Un modelo está «instalado» si el archivo final existe con el tamaño exacto.
- **Motor** (`src/services/moderation-ai-local.ts`): mismo prompt que Gemini (`moderation-ai-prompt.ts`) como `systemPrompt` y la salida restringida por una **gramática de JSON Schema** (`llama.createGrammarForJsonSchema`): un objeto con exactamente las claves del lote, cada una con una de las cinco categorías (`additionalProperties: false`). `temperature: 0`, máximo 256 tokens de salida, contexto de 4096 tokens, hilos ≈ uno por núcleo físico: `max(1, min(lógicos − 1, ⌈lógicos ÷ 2⌉))` (con 15 hilos en un portátil de 16 hilos lógicos un lote tardó 51,5 s; con 8, 13,4 s). Cada lote usa una sesión nueva (sin historial entre lotes) y las clasificaciones se serializan (una sola secuencia de contexto, aunque revisen varias cuentas). La salida pasa por el mismo `sanitizeAiResult`. El modelo queda en memoria mientras se usa y se descarga tras **5 min** sin uso; elegir otro modelo reemplaza al cargado.
- **Recursos:** el modelo de 1,5B necesita ~1,5–2 GB de RAM libre (recomendado: 8 GB de RAM en el equipo); el de 4B, ~3,5–4 GB (recomendado: 16 GB). Mientras revisa usa cerca de la mitad de los hilos lógicos (`max(1, min(n − 1, ceil(n / 2)))`).
- **Borrar:** pide `confirmed: true`; se rechaza (409 `model_in_use`) si un trabajo en curso usa ese modelo y antes descarga el modelo de memoria (Windows no permite borrar un archivo mapeado). También borra el `.part`.

API del modelo local (global a la instalación, no por cuenta; escrituras con origen + CSRF + JSON):

- `GET /api/moderation/ai-local/status` → `{ models: [{ id, label, sizeBytes, installed, partialBytes }], download?: { model, state: 'running'|'completed'|'failed'|'cancelled', receivedBytes, totalBytes, errorCode? } }`. Sin rutas locales.
- `POST /api/moderation/ai-local/download` `{ model }` → 202 con el estado; 400 `invalid_request` (id desconocido), 409 `download_running`, `model_installed`, `insufficient_disk`.
- `POST /api/moderation/ai-local/download/cancel` → estado (`cancelled`, el `.part` se conserva); 409 `download_not_running`.
- `POST /api/moderation/ai-local/delete` `{ model, confirmed: true }` → estado; 400 `confirmation_required`, 409 `model_in_use` o `download_running`.
