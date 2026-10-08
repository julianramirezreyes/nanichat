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

Consecuencia en macOS/Windows: tras un cierre forzado, si el PID anotado ya lo usa otro proceso, el humano debe confirmar que no hay otra instancia y borrar el archivo a mano.
Estado global en la tabla `app_state`:

- `dry_run`: `true` en una base nueva; se conserva entre reinicios.
- `monitoring_enabled`: se fuerza a `false` en cada arranque, y todas las cuentas quedan con el monitoreo en pausa.

### Pérdida de la llave

Si falta `vault.key` mientras existen credenciales cifradas, o una credencial no se puede autenticar con la llave existente, el arranque falla a propósito (`Vault key is missing…` / `Vault key is invalid…`). Nunca se crea una llave de reemplazo en silencio ni se sobrescribe la base. Restaura la llave correspondiente desde la copia de seguridad o, si se perdió, mueve la carpeta de datos a otro lugar y vuelve a crear las conexiones con tokens nuevos.

Respalda siempre la carpeta completa (base **y** llave) con la aplicación detenida.

## 3. Esquema y migraciones

`src/db/migrations.ts` aplica en **una sola transacción** todas las migraciones pendientes al arrancar y deja la versión en `PRAGMA user_version`. La versión actual es **11**. Una base con versión mayor que la soportada se rechaza (`Database schema version N is newer than supported version 11`), así que no hay vuelta atrás sin una copia de seguridad.

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
| `SKIPPED` | La revalidación previa al envío encontró que ya no está permitido. |
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
- El Monitoreo revisa la primera página de comentarios (más una continuación) en cada ciclo; el historial profundo se cubre poco a poco o con un escaneo de Revisión pendiente, y puede quedar parcial.
- La detección de «ya respondido» depende de las respuestas guardadas por escaneos anteriores; no hay comprobación en vivo al enviar.
- El comportamiento de las respuestas privadas (permisos, reglas de 24 h/7 días, cómo se ven los botones) depende de Meta y debe comprobarse con un comentario real controlado antes de un uso amplio.
- La retención heredada solo conoce el formato de carpetas descrito en la sección 12 (`run.lock` y los nombres de contador listados).
