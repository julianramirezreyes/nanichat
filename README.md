# Social Desk — respuestas automáticas a comentarios de Instagram, en tu propia computadora

Social Desk es una aplicación **local y de un solo usuario** que se conecta a tu cuenta de Instagram a través de la API de Meta, vigila los comentarios de tus publicaciones y, cuando un comentario contiene una palabra clave que tú definiste, le envía a esa persona una **respuesta privada** (mensaje directo) y, si lo activas, también una respuesta pública debajo del comentario.

Todo corre en tu máquina: la interfaz web, la base de datos, la bóveda de credenciales y el programador de tareas. No hay servidores en la nube ni cuentas de terceros, aparte de la propia API de Meta.

> **Importante:** por defecto la aplicación **no envía nada**. Arranca en **Dry Run** (modo prueba) y con el **Monitoreo** apagado. Para enviar mensajes reales tienes que desactivar varias protecciones a propósito y confirmar cada una.

## Contenido

- [Qué hace y qué no hace](#qué-hace-y-qué-no-hace)
- [Estado y límites](#estado-y-límites)
- [Funciones probadas y retiradas](#funciones-probadas-y-retiradas)
- [Instalador para Windows](#instalador-para-windows)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Instalar con una IA](#instalar-con-una-ia)
- [Abrir la aplicación](#abrir-la-aplicación)
- [Variables de entorno](#variables-de-entorno)
- [Primeros pasos](#primeros-pasos)
- [Dónde viven tus datos](#dónde-viven-tus-datos)
- [Copias de seguridad y qué nunca compartir](#copias-de-seguridad-y-qué-nunca-compartir)
- [Actualizar a una versión nueva](#actualizar-a-una-versión-nueva)
- [Manual de usuario (PDF)](#manual-de-usuario-pdf)
- [Documentación técnica](#documentación-técnica)
- [Contribuir y ejecutar las pruebas](#contribuir-y-ejecutar-las-pruebas)
- [Licencia](#licencia)

## Qué hace y qué no hace

**Hace:**

- Guarda conexiones de Meta (Instagram Login o Facebook Login) con el token **cifrado** en tu disco.
- Lista tus publicaciones y te deja crear **automatizaciones**: palabras clave + texto de respuesta + hasta dos botones con enlace HTTPS. Pueden aplicar a una publicación o a todas las publicaciones de la cuenta (automatización general).
- **Monitoreo** de comentarios nuevos (cada 60 segundos) que pone en cola las respuestas de los comentarios elegibles.
- **Revisión pendiente**: analiza comentarios anteriores (últimas 2 h, 24 h, 3 días, 7 días o un rango propio) **sin enviar nada**, para que tú elijas cuáles procesar.
- **Cola e historial**: muestra cada respuesta (simulada, enviada, fallida, expirada o con resultado desconocido) y su historial de intentos.
- Respuesta pública opcional bajo el comentario, con variantes que rotan para no repetir siempre el mismo texto.
- Para entregar un audio o un video: ponlo en tu página y enlázalo con un botón de enlace.

**No hace:**

- No publica contenido, no responde mensajes directos entrantes y no usa inteligencia artificial.
- No es un servicio en la nube ni multiusuario: no tiene inicio de sesión; solo acepta conexiones desde la propia máquina (`127.0.0.1` / `localhost`).
- No soporta TikTok ni otras redes.
- No reintenta un envío cuyo resultado es dudoso (`UNKNOWN_OUTCOME`): eso lo resuelves tú a mano.

## Estado y límites

- **Herramienta local para una sola persona.** Pensada para administrar tus propias cuentas desde tu computadora.
- **Reglas de Meta que la aplicación respeta y no puede cambiar:**
  - Solo se puede enviar **una respuesta privada por comentario**.
  - La respuesta privada solo es posible dentro de los **7 días** siguientes al comentario. Pasado ese plazo, el elemento queda como `EXPIRED` y no se envía.
  - Solo se responde a comentarios principales (no a respuestas dentro de un hilo).
- **Cuentas de otras personas:** usar la aplicación con cuentas que no son tuyas (o que no administras dentro de tu app de Meta) requiere que tu app de Meta pase la **App Review** y obtenga los permisos avanzados correspondientes. Sin eso, Meta rechazará las llamadas.
- **Botones interactivos experimentales retirados:** la sección «Botones interactivos (experimental)» ya no existe (sus botones no hacían nada al tocarlos); la API la rechaza con `interactive_mode_retired` y una automatización antigua con ese modo vuelve a enviar su mensaje normal. «Inspeccionar conversación» sigue disponible (solo lectura).
- **«Pedir que me sigan» y el adjunto del recurso: probados y retirados.** Ver [Funciones probadas y retiradas](#funciones-probadas-y-retiradas).
- **Permisos de comentarios:** no sabrás si tu token tiene permiso para responder públicamente hasta el primer intento real. Si falta, verás `public_reply_permission_denied` y la respuesta privada no se ve afectada.
- **Sistema operativo:** el código es multiplataforma (Linux, macOS y Windows nativo, además de Windows con WSL2), pero solo **Linux** se verificó en una ejecución real. macOS y Windows nativo están **verificados solo por pruebas automáticas con una sonda de plataforma simulada; no se probaron en un equipo real**. Detalles en [Sistemas operativos](docs/INSTALACION-CON-IA.md#sistemas-operativos).
- **Proyecto en evolución:** el comportamiento real de Meta (permisos, cómo se ven los botones, límites de volumen) debe comprobarse con un comentario de prueba controlado antes de usarlo en serio.

## Funciones probadas y retiradas

**«Pedir primero que me sigan (sin comprobación)»** y **«Adjunto del recurso»** existieron y se retiraron el 2026-10-09. No aparecen en la interfaz y la API las rechaza (`follow_gate_retired`, `attachment_retired`).

- **Qué se probó:** el primer mensaje privado llevaba un botón («Ya te sigo»). La aplicación detectaba el toque leyendo la conversación (sondeo) y luego enviaba el recurso (el texto con sus botones y, opcionalmente, una imagen, un audio, un video o un PDF por URL) con `POST /<IG_ID>/messages` y `recipient.id`.
- **Qué pasó en la prueba real:** 41 segundos después de un toque detectado, Meta rechazó el envío del recurso con HTTP 403, código **10**, subcódigo **2534022** («This message is sent outside of allowed window»; ver la [tabla de errores de Meta](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)). La consulta de seguimiento del perfil respondió además código **230** («User consent required»).
- **Por qué se retiró:** Meta no cuenta ese toque (en un hilo iniciado por la cuenta con una respuesta privada, visto por una aplicación que solo sondea) como un mensaje de la persona que abra la ventana de 24 horas. Resultado: quien tocaba el botón **no recibía nada**. Activa, la función hacía daño.
- **Qué queda:** el código está inactivo detrás de un único interruptor (`FOLLOW_GATE_AVAILABLE = false` en `src/services/follow-gate-rules.ts`). Una automatización antigua con estas opciones envía su mensaje normal; los elementos en cola con el botón quedan `SKIPPED` (`follow_gate_retired`); los seguimientos que esperaban un toque quedan `CANCELLED` sin llamar a Meta; el historial de las pruebas sigue visible en «Cola e historial».
- **Qué haría falta para una versión futura:** recibir el toque por **webhooks** (evento `messaging_postbacks`) en un servidor accesible desde internet, comprobar en vivo que así Meta sí abre la ventana de mensajería y, solo entonces, cambiar el interruptor. Que los webhooks lo resuelvan es una **hipótesis no verificada**.

## Instalador para Windows

Si usas Windows y no quieres instalar Node.js ni usar la terminal, usa el instalador:

1. Abre la página de [Releases](https://github.com/julianramirezreyes/social-automation/releases) y descarga `SocialDesk-Setup-<versión>.exe`.
2. Haz doble clic. No pide permisos de administrador.
3. Windows puede mostrar «Windows protegió su PC» (SmartScreen) porque el instalador **no está firmado**: pulsa **Más información → Ejecutar de todas formas**.
4. Abre **Social Desk** con el icono del escritorio (o menú Inicio → Social Desk). Se abre en tu navegador en `http://localhost:3000`; si ese puerto está ocupado, usa el primero libre entre 3001 y 3020.

| Qué | Dónde / cómo |
| --- | --- |
| Programa | `%LOCALAPPDATA%\Programs\SocialDesk` (incluye su propio Node.js). |
| Tus datos | `%LOCALAPPDATA%\SocialDesk\data` (base de datos y `vault.key`); registros en `%LOCALAPPDATA%\SocialDesk\logs`. |
| Cerrar la aplicación | Menú Inicio → Social Desk → **Detener Social Desk**. |
| Manual | Menú Inicio → Social Desk → **Manual de usuario**. |
| Actualizar | Respalda la carpeta `data` y ejecuta el instalador nuevo encima; tus datos se conservan. |
| Desinstalar | Configuración → Aplicaciones → Social Desk → Desinstalar. **Tus datos no se borran**; si quieres eliminarlos, borra la carpeta `data` a mano. |

Necesitas **tus propias credenciales de Meta**; el instalador no incluye ninguna. Igual que siempre, la aplicación arranca en Dry Run y con el Monitoreo apagado.

El instalador se compila y se **prueba automáticamente en un Windows de GitHub** (instalación silenciosa, arranque, cierre, reinicio y desinstalación). Esa prueba automática pasó por completo en la versión 0.1.0 (56 comprobaciones). Todavía no se probó a mano en un equipo Windows de una persona usuaria, y las pruebas unitarias de la app no terminan aún en Windows (se agota el tiempo), así que Windows está verificado para el instalador, no para ejecutar el código fuente. Detalles técnicos: [packaging/windows/README.md](packaging/windows/README.md).

## Requisitos

| Requisito | Detalle |
| --- | --- |
| Node.js | **24.21.0 o superior** (la app usa el módulo integrado `node:sqlite`). Revisa con `node -v`. |
| npm | El que viene con Node (probado con npm 11). |
| git | Para clonar y actualizar el repositorio. |
| Sistema | Linux (verificado), macOS o Windows nativo/WSL2 (sin probar en un equipo real; ver arriba). En Windows existe además un [instalador](#instalador-para-windows) que no requiere nada de esta tabla. |
| Puerto | `3000` libre (o el que indiques con la variable `PORT`). |
| Red | Solo para `npm install` (registro de npm) y, al usar la app, para hablar con la API de Meta. |

No necesitas base de datos externa, Docker ni claves de ningún servicio para instalar y abrir la aplicación.

## Inicio rápido

```bash
git clone <URL del repositorio> social-automation
cd social-automation
npm install
npm run build
npm start
```

Luego abre <http://localhost:3000>. Para comprobar que el servidor responde:

```bash
curl http://127.0.0.1:3000/api/health
# Respuesta esperada: {"status":"ok","ready":true}
```

Para detener el servidor, presiona `Ctrl+C` en la terminal donde corre.

Los mismos comandos funcionan en Linux, macOS, Windows PowerShell y `cmd`: `npm start` ejecuta `node scripts/start.mjs`, que activa el modo producción sin depender de la sintaxis de la terminal. En Windows, si PowerShell bloquea `npm` por la política de ejecución, usa `npm.cmd start` o abre `cmd`.

> **Nota:** `npm install` puede mostrar un aviso de npm sobre `esbuild` y sus *install scripts*. Es inofensivo: el binario de `esbuild` llega en un paquete opcional por plataforma y la app funciona sin aprobar ese script.

## Instalar con una IA

Si usas un asistente de programación con acceso a tu terminal (Claude Code, Codex, Cursor, agentes de ChatGPT, etc.), puede hacer toda la instalación por ti. La guía [docs/INSTALACION-CON-IA.md](docs/INSTALACION-CON-IA.md) está escrita para que la siga una IA **y** la revises tú: incluye las verificaciones previas, los comandos exactos, cómo saber que todo salió bien, una tabla de problemas frecuentes y **reglas de seguridad** que la IA debe respetar (por ejemplo, nunca desactivar Dry Run ni leer tus tokens).

Ve a la sección [Prompt para pegar a tu IA](docs/INSTALACION-CON-IA.md#prompt-para-pegar-a-tu-ia), copia el bloque, reemplaza `<URL del repositorio>` y pégalo en tu asistente.

Si una IA va a **modificar el código**, debe leer además [AGENTS.md](AGENTS.md).

## Abrir la aplicación

- Dirección por defecto: <http://localhost:3000> (también sirve <http://127.0.0.1:3000>).
- El servidor escucha **solo** en `127.0.0.1`. Cualquier otro nombre de host recibe un error `421 invalid_local_host`; no es accesible desde otras computadoras de tu red.
- Para usar otro puerto, define `PORT` (la forma de definir una variable depende de la terminal):

  ```bash
  # Linux / macOS (bash, zsh)
  PORT=3310 npm start
  ```

  ```powershell
  # Windows PowerShell
  $env:PORT = "3310"; npm start
  ```

  ```bat
  :: Windows cmd
  set PORT=3310
  npm start
  ```

  Y abre <http://localhost:3310>.

- Modo desarrollo (recarga en caliente, solo para quien modifica el código): `npm run dev`.
- Solo puede correr **una instancia por carpeta de datos**. Si intentas iniciar otra con la misma carpeta, se detiene con el error `Application data directory is already running or ownership is uncertain`. Si la aplicación se cerró de golpe, el bloqueo se recupera solo cuando el proceso anterior ya no existe. En macOS y Windows, si ese número de proceso fue reutilizado por otro programa, la aplicación no puede distinguirlo y se niega a arrancar; ver [Problemas frecuentes](docs/INSTALACION-CON-IA.md#problemas-frecuentes).

## Variables de entorno

Todas son opcionales. Sin ninguna, la aplicación usa el puerto `3000`, la carpeta `./data` y deja **desactivadas** las dos funciones opcionales (retención heredada e importación de `.env`).

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `PORT` | `3000` | Puerto local (siempre en `127.0.0.1`). |
| `LOCAL_SOCIAL_DATA_DIR` | `./data` | Carpeta de datos (base de datos, `vault.key`, bloqueo de instancia). |
| `SOCIAL_DESK_IMPORT_ENV_PATH` | sin definir: **importación desactivada** | Ruta del único archivo `.env` que puede leer el botón «Importar .env del proyecto» (Ajustes). Solo se leen variables permitidas de Meta (`INSTAGRAM_ACCESS_TOKEN`, `META_APP_ID`, `GRAPH_API_VERSION`, …); el token se guarda cifrado. Sin la variable, el botón no aparece y Ajustes muestra cómo activarlo. |
| `SOCIAL_DESK_LEGACY_ACCOUNTS_DIR` | sin definir: **no se lee ninguna carpeta** | Solo si usaste antes otra herramienta que guarda una carpeta por cuenta con `run.lock` y contadores de rechazos (`rejection-counter.json` y similares). Con ella, una cuenta con bloqueo o historial de rechazos empieza retenida y no envía hasta que reconozcas su historial; mientras envía, la aplicación crea y respeta `run.lock` en esa carpeta. |
| `SOCIAL_DESK_LEGACY_HOLD_USERNAMES` | vacía | Lista separada por comas de cuentas (`cuenta_uno,cuenta_dos`) que empiezan **retenidas** al seleccionarlas, aunque no haya contador; se liberan con «Revisar estado y reconocer» en Conexiones. |
| `SOCIAL_DESK_HOME` | `%LOCALAPPDATA%\SocialDesk` | **Solo el lanzador del instalador de Windows** (no la aplicación): carpeta base de `data`, `logs` y `run`. Pensada para pruebas; el lanzador fija `LOCAL_SOCIAL_DATA_DIR` y `PORT` a partir de ella. |
| `SOCIAL_DESK_NONINTERACTIVE` | sin definir | **Solo el lanzador de Windows**: con `1`, `launch.ps1`/`stop.ps1` no muestran cuadros de diálogo (pruebas automáticas). |

Las rutas relativas se resuelven desde la carpeta donde inicias el servidor; en las dos rutas `SOCIAL_DESK_*`, `~/` se expande a tu carpeta personal. Un nombre inválido en `SOCIAL_DESK_LEGACY_HOLD_USERNAMES` impide arrancar (falla de forma segura). Ejemplo en PowerShell: `$env:SOCIAL_DESK_IMPORT_ENV_PATH = "C:\ruta\a\.env"; npm start`.

## Primeros pasos

El [manual de usuario](#manual-de-usuario-pdf) explica cada pantalla con capturas. En resumen:

1. **Conexiones:** crea una conexión con un nombre, el tipo de inicio de sesión (Instagram Login o Facebook Login), la versión de Graph API y tu token de acceso (`TU_TOKEN`). El token se envía una sola vez y nunca se vuelve a mostrar.
2. Pulsa **Probar y descubrir**, revisa las cuentas encontradas (por ejemplo `@tu_cuenta`) y selecciona la que quieres administrar.
3. **Publicaciones:** pulsa **Actualizar publicaciones** para traer tus publicaciones.
4. **Automatizaciones:** crea una regla (palabras clave, texto de respuesta, botones opcionales) y actívala. Solo los comentarios posteriores a la activación son candidatos.
5. **Monitoreo:** enciéndelo por cuenta o para todas. **Siempre arranca apagado**, también después de cada reinicio.
6. **Cola e historial:** con **Dry Run** activo, verás elementos `SIMULATED` («No se envió (modo prueba)»). Nada sale hacia Meta.

> **Importante:** **Dry Run** está activo por defecto y su estado se conserva entre reinicios. Enviar mensajes reales exige, a la vez: desactivar Dry Run con confirmación, **Autorizar real** cada automatización con confirmación, una conexión y cuenta válidas y el Monitoreo encendido. Prueba primero con una cuenta y un comentario controlados.

## Dónde viven tus datos

| Qué | Dónde |
| --- | --- |
| Carpeta de datos | `./data` (relativa a la carpeta desde donde inicias el servidor). Cámbiala con `LOCAL_SOCIAL_DATA_DIR=/ruta/absoluta`. Está en `.gitignore`. |
| Base de datos | `<carpeta de datos>/social-automation.sqlite` (más sus archivos `-wal` y `-shm`). |
| Llave de la bóveda | `<carpeta de datos>/vault.key`: llave maestra aleatoria AES-256-GCM de 32 bytes, guardada fuera de la base de datos. |
| Bloqueo de instancia | `<carpeta de datos>/.application-owner.json` (se borra al cerrar normalmente). |
| Con el instalador de Windows | Carpeta de datos `%LOCALAPPDATA%\SocialDesk\data`; registros en `%LOCALAPPDATA%\SocialDesk\logs` (se borran a los 14 días). |

La carpeta de datos se crea con permisos `0700` y los archivos con `0600`. Los tokens se guardan cifrados con `vault.key` y nunca se devuelven al navegador.

Ejemplo con otra carpeta de datos:

```bash
LOCAL_SOCIAL_DATA_DIR="$HOME/social-desk-datos" npm start      # Linux / macOS
```

```powershell
$env:LOCAL_SOCIAL_DATA_DIR = "$HOME\social-desk-datos"; npm start   # Windows PowerShell
```

En Windows, los permisos `0700`/`0600` no se aplican: protege la carpeta con los permisos de tu usuario de Windows.

> **Importante:** si falta `vault.key` y la base de datos tiene credenciales cifradas, la aplicación **se niega a arrancar** a propósito. Nunca crea una llave nueva en silencio ni sobrescribe la base. **No borres ni regeneres `vault.key`:** restáurala desde tu copia de seguridad.

## Copias de seguridad y qué nunca compartir

- Respalda **toda** la carpeta de datos (base de datos **y** `vault.key` juntas), **con la aplicación detenida**. Una base sin su llave no puede descifrar los tokens, y la llave sola no sirve de nada.
- Haz una copia **antes de actualizar**: la base de datos se migra sola al arrancar una versión nueva y no se puede volver atrás.
- Si perdiste la llave, mueve la carpeta de datos a otro lugar y vuelve a crear las conexiones con tokens nuevos.

**Nunca compartas, subas a git ni pegues en un chat (tampoco a una IA):**

- `data/vault.key` ni ningún archivo de la carpeta de datos.
- Tus tokens de acceso de Meta ni archivos `.env`.
- Capturas de pantalla o registros que muestren tokens o identificadores de tus cuentas.

Quien tenga la base de datos **y** la llave puede leer tus tokens. Si alguien con acceso a tu usuario del sistema operativo puede leer esos archivos, la aplicación no te protege de eso.

## Actualizar a una versión nueva

1. Detén la aplicación (`Ctrl+C`).
2. Respalda la carpeta de datos completa (por ejemplo `cp -a data "data-respaldo-$(date +%Y%m%d)"` en Linux/macOS, o `Copy-Item -Recurse data data-respaldo` en PowerShell).
3. Ejecuta:

   ```bash
   git pull
   npm install
   npm run build
   npm start
   ```

Al arrancar, la base de datos se migra automáticamente al esquema nuevo. Una versión anterior de la aplicación **no puede abrir** una base ya migrada (se detiene con `Database schema version … is newer than supported version …`); por eso la copia del paso 2 es tu única forma de volver atrás. La guía para IA incluye un [prompt para actualizar](docs/INSTALACION-CON-IA.md#prompt-para-actualizar-a-la-última-versión).

> **Cambio en esta versión:** la importación de `.env` ya no lee un archivo fijo junto al proyecto y la retención heredada ya no tiene cuentas definidas en el código. Si usabas alguna de las dos, define `SOCIAL_DESK_IMPORT_ENV_PATH`, `SOCIAL_DESK_LEGACY_ACCOUNTS_DIR` o `SOCIAL_DESK_LEGACY_HOLD_USERNAMES` antes de iniciar (ver [Variables de entorno](#variables-de-entorno)). Los reconocimientos guardados en la base se conservan.

## Manual de usuario (PDF)

- Manual con capturas de todas las pantallas: [docs/manual/Manual-Social-Desk.pdf](docs/manual/Manual-Social-Desk.pdf).
- Para regenerarlo desde `docs/manual/manual.html` (necesitas Google Chrome; usa otro navegador con `CHROME=/ruta/al/navegador`):

  ```bash
  bash docs/manual/build-pdf.sh
  ```

- Las capturas se regeneran con datos 100 % ficticios; ver [docs/manual/tools/README.md](docs/manual/tools/README.md).

## Documentación técnica

- [docs/REFERENCIA-TECNICA.md](docs/REFERENCIA-TECNICA.md): arquitectura, esquema y migraciones, estados de la cola, programador, revisión pendiente, lectura de comprobación, respuesta pública, automatizaciones generales, modelo de seguridad y limitaciones conocidas.
- [AGENTS.md](AGENTS.md): convenciones e invariantes para agentes de IA (y personas) que modifican el código.
- [docs/INSTALACION-CON-IA.md](docs/INSTALACION-CON-IA.md): instalación paso a paso y solución de problemas.

## Contribuir y ejecutar las pruebas

```bash
npm test            # pruebas con node:test sobre bases de datos temporales
npm run typecheck   # verificación de tipos con TypeScript
```

- Las pruebas nunca tocan `./data` ni llaman a Meta: usan carpetas temporales y proveedores simulados.
- `npm test` funciona igual en Windows: el propio Node expande el patrón `tests/*.test.ts`.
- `tests/server.test.ts` levanta el servidor en modo desarrollo en puertos libres elegidos al azar; si tienes un `npm run dev` abierto en la misma carpeta, Next.js lo rechaza con `Another next dev server is already running in this directory.` Detén el servidor de desarrollo antes de correr las pruebas.
- El proyecto sigue TDD: primero una prueba que falla, luego el código. Lee [AGENTS.md](AGENTS.md) antes de enviar cambios.

## Licencia

Este proyecto se publica bajo la **licencia MIT**: puedes usar, copiar, modificar y distribuir el código, incluso con fines comerciales, siempre que conserves el aviso de derechos de autor. Se ofrece **«tal cual», sin garantía de ningún tipo**. El texto completo está en el archivo [LICENSE](LICENSE).

> **Importante:** la licencia cubre el código de este repositorio. No te da ningún derecho sobre las marcas ni las APIs de Meta ni de Instagram. Quien use la aplicación es responsable de cumplir las políticas de la plataforma de Meta y las leyes de su país.
