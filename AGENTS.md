# AGENTS.md — guía para agentes de IA que trabajan en este repositorio

Este archivo es para asistentes de programación (Claude Code, Codex, Cursor, etc.) y para personas que modifican el código. Si solo quieres **instalar** la aplicación, lee [docs/INSTALACION-CON-IA.md](docs/INSTALACION-CON-IA.md).

> **Importante:** este repositorio es **público**. Nunca escribas en código, pruebas, documentación ni mensajes de commit tokens reales, identificadores reales de cuentas o publicaciones, nombres de usuario reales ni rutas privadas. Usa marcadores como `TU_TOKEN`, `@tu_cuenta` o datos generados en las pruebas.

## Reglas de trabajo

- **No hagas commits ni push** salvo que el humano lo pida explícitamente. Deja los cambios sin confirmar para que la persona dueña decida.
- **No toques datos reales:** nunca leas, modifiques ni borres `./data` (base de datos, `vault.key`), archivos `.env` ni tokens. Para cualquier prueba manual, usa `LOCAL_SOCIAL_DATA_DIR` apuntando a una carpeta temporal nueva y un `PORT` distinto de `3000`.
- **No detengas ni reinicies** una instancia que tú no iniciaste (por ejemplo, la que corre en el puerto 3000). Detén solo tus procesos, por PID.
- **No hagas llamadas reales a Meta.** Las pruebas usan proveedores simulados; la demo del manual usa un proveedor falso sin red (`docs/manual/tools/demo-provider.ts`).
- **No ejecutes `npm run build`** en una carpeta donde corre la instancia de producción: reemplaza la carpeta `.next` que esa instancia está usando. Compila en una copia (`git clone` a una carpeta temporal) o pídele al humano que lo haga.
- Escribe los artefactos técnicos (código, comentarios, pruebas) en inglés, como el código existente. La interfaz de usuario está en español.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm install` | Instala dependencias (requiere Node ≥ 24.21.0). |
| `npm run dev` | Servidor en modo desarrollo (`tsx server.ts`, Next.js con recarga en caliente). |
| `npm run build` | Compila la interfaz (`next build`) en `.next`. |
| `npm start` | Servidor en modo producción (`node scripts/start.mjs`: pone `NODE_ENV=production` y carga `server.ts` con la API de `tsx`; funciona en PowerShell, `cmd`, macOS y Linux). Requiere `npm run build` previo. |
| `npm test` | Todas las pruebas (`node --import tsx --test --test-timeout=120000 --test-force-exit tests/*.test.ts`). Las opciones de `node` van siempre antes del patrón de archivos: después de él se ignoran sin aviso, así que `npm test -- --opcion` no sirve. |
| `npm run typecheck` | `tsc --noEmit`. |
| `node packaging/windows/fetch-node.mjs` y `node packaging/windows/build-payload.mjs` | Arman el instalador de Windows (los ejecuta el flujo `.github/workflows/windows-installer.yml` en Windows; ver [packaging/windows/README.md](packaging/windows/README.md)). |
| `curl http://127.0.0.1:3000/api/health` | Verificación de salud: `{"status":"ok","ready":true}`. |

Variables de entorno: `PORT` (por defecto `3000`), `LOCAL_SOCIAL_DATA_DIR` (por defecto `./data`) y tres opcionales que activan funciones desactivadas por defecto: `SOCIAL_DESK_IMPORT_ENV_PATH` (importación de `.env`), `SOCIAL_DESK_LEGACY_ACCOUNTS_DIR` y `SOCIAL_DESK_LEGACY_HOLD_USERNAMES` (retención heredada). Tabla completa en [README.md](README.md#variables-de-entorno). Nunca escribas en el código nombres de cuentas ni rutas personales: todo lo específico de una instalación va en esas variables.

`tsx` debe seguir en `dependencies` y la configuración de Next.js debe seguir siendo `next.config.mjs`: el instalador de Windows instala solo dependencias de producción y no incluye el compilador SWC.

`node-llama-cpp` (motor del modelo local) va en `dependencies` con versión exacta y **nunca** se importa de forma estática: solo con `import()` dinámico dentro de `src/services/moderation-ai-local.ts`, para que un binario nativo que no carga no impida arrancar. `npm test` nunca carga el módulo real ni un modelo (las pruebas inyectan un módulo falso) ni descarga nada (las descargas usan un `fetch` falso).

Los scripts de `package.json` no deben usar sintaxis de una terminal concreta (`VAR=valor`, `$(...)`, `&&`): deben funcionar en Windows, macOS y Linux. `tests/start-script.test.ts` lo comprueba.

## Mapa de la arquitectura

```text
server.ts                    Punto de entrada: bloqueo de instancia, base de datos, migraciones, bóveda,
                             servicios, router de la API y Next.js en un único servidor HTTP en 127.0.0.1.
scripts/start.mjs            Arranque de producción portable (NODE_ENV=production + tsx en el mismo proceso).
src/core/                    config.ts (variables de entorno), application-lock.ts (una instancia por carpeta,
                             sonda de plataforma inyectable: kill(pid, 0) en todos los sistemas, /proc en Linux),
                             domain.ts (tipos compartidos), errors.ts.
src/db/                      database.ts (SQLite, WAL, foreign keys), migrations.ts (esquema v1..v18),
                             repositories.ts (consultas compartidas).
src/security/                vault.ts (AES-256-GCM, vault.key), redact.ts (borra secretos de textos),
                             env-import.ts (importación explícita del .env de SOCIAL_DESK_IMPORT_ENV_PATH).
src/providers/meta/          provider.ts: único punto que habla con la Graph API de Meta.
src/services/                connections, automations (clasificación y plantillas), scanner (lectura de comentarios),
                             backlog (Revisión pendiente), pending-review, queue (cola, envío, read-back,
                             respuesta pública), public-reply (variantes), scheduler (Monitoreo), legacy-interlock (opcional),
                             follow-gate + follow-gate-rules («Pedir que me sigan», RETIRADO: código inactivo detrás de
                             FOLLOW_GATE_AVAILABLE = false), resource-attachment (adjunto del recurso, RETIRADO e inactivo),
                             moderation-rules (clasificación pura de comentarios para moderar) + moderation (marcas,
                             ocultar/mostrar/borrar con intención durable, acciones masivas y auto-ocultar solo en modo real),
                             moderation-ai + moderation-ai-gemini + moderation-ai-prompt + moderation-ai-engine (revisión con IA:
                             desactivada por defecto, key de Gemini cifrada, lotes que solo crean marcas, nunca llaman a Meta),
                             moderation-ai-local (motor local: node-llama-cpp importado con import() dinámico, solo CPU,
                             gramática JSON Schema) + moderation-ai-local-model (catálogo GGUF fijado por commit/SHA-256 y
                             descarga única verificada a <LOCAL_SOCIAL_DATA_DIR>/models).
src/http/router.ts           API JSON /api/*: guardas de host, origen y CSRF; DTOs con campos permitidos.
app/                         Interfaz Next.js (page.tsx) y funciones puras de presentación con pruebas propias.
tests/                       Pruebas node:test (bases de datos temporales, proveedores simulados).
docs/                        Documentación; docs/manual tiene el manual PDF y sus herramientas de captura.
```

Detalle completo en [docs/REFERENCIA-TECNICA.md](docs/REFERENCIA-TECNICA.md).

## Invariantes que nunca debes romper

Cada cambio debe preservar estas reglas. Si una tarea parece exigir romper alguna, detente y pregúntale al humano.

1. **Dry Run por defecto.** Una base de datos nueva arranca con Dry Run activo y el Monitoreo apagado; el Monitoreo se apaga en cada arranque. Desactivar Dry Run y autorizar envíos reales («Autorizar real») requieren confirmación explícita (`confirmed: true`). En Dry Run nunca se llama al proveedor para enviar: los elementos quedan `SIMULATED` y son inertes.
2. **Escanear nunca envía.** El escaneo y la Revisión pendiente solo leen y clasifican. Encolar comentarios antiguos es una acción separada, explícita y confirmada, que solo acepta clasificaciones `eligible` de un escaneo **completo** de esa cuenta y automatización; si un solo ID falla, se rechaza toda la solicitud.
3. **Privado primero, público después.** La respuesta pública solo se programa cuando la privada fue **aceptada** (`SENT` con ID de mensaje), en la misma transacción. Ningún resultado de la respuesta pública cambia el estado de la privada ni la reenvía.
4. **Una respuesta privada por comentario.** Garantizado por índices únicos en `queue_items` (`account_id, comment_id`). No lo relajes.
5. **Intención antes del POST (idempotencia).** Antes de cada envío se relee y revalida el comentario y, después, se confirma en la base una intención inmutable (`intent_recorded`, estado `SENDING`); solo entonces se hace el POST. Las tablas de intentos (`send_attempts`, `public_reply_attempts`) son de solo inserción (triggers que bloquean UPDATE y DELETE).
6. **`UNKNOWN_OUTCOME` nunca se reintenta automáticamente.** Un resultado ambiguo (timeout, error de red, 5xx, respuesta sin ID, reinicio con un envío en curso) se queda así hasta que una persona lo resuelva.
7. **Todo está acotado por cuenta.** Cada consulta y cada endpoint que actúa sobre una cola, automatización o publicación comprueba que pertenece a la cuenta indicada (`accountId`). No mezcles datos entre cuentas.
8. **Los secretos nunca salen.** Los tokens se guardan cifrados y nunca aparecen en DTOs, respuestas de la API, registros, errores ni eventos. Las respuestas usan listas de campos permitidos; usa `redactSecrets` para cualquier texto que pueda contener un token. Nunca regeneres `vault.key` si hay credenciales cifradas.
9. **Solo local.** El servidor escucha en `127.0.0.1`, rechaza hosts distintos de `127.0.0.1`/`localhost` (421) y exige mismo origen + token CSRF + JSON en las escrituras.
10. **Migraciones solo hacia adelante y sin pérdida.** Agrega una migración nueva con `PRAGMA user_version` siguiente; nunca edites una ya publicada ni borres historial. Las bases con versión mayor a la soportada se rechazan.
11. **Ventanas de Meta.** Respuesta privada: menos de 7 días desde el comentario (límite conservador). Respuesta pública: dentro de las 24 horas posteriores a la privada aceptada. (El recurso del follow gate, hoy retirado, tampoco se pudo enviar dentro de esas 24 horas: ver el invariante 16.)
12. **Follow gate: el recurso se envía como máximo una vez por sesión.** Transiciones con estado esperado, intención durable (`resource_intent_recorded`, estado `RESOURCE_SENDING`) antes del POST, a lo sumo un evento `resource_accepted` por sesión (índice único) y `gate_events` de solo inserción. Un resultado ambiguo queda `UNKNOWN_OUTCOME` y **nunca** se reintenta; solo el límite de uso de Meta (429 / códigos 4, 17, 32, 613) reintenta el envío, como máximo 3 veces y dentro de la ventana. La sesión se crea en la misma transacción que marca `SENT` el primer mensaje; en Dry Run no hay sesiones ni llamadas.
13. **El follow gate nunca afirma verificar el seguimiento.** Meta no permite comprobarlo (error 230 «User consent is required»); ni la interfaz, ni la API, ni la documentación pueden decir que se verificó. El toque del botón es lo único que se detecta.
14. **Adjunto del recurso: cada parte se envía como máximo una vez.** Una sesión con adjunto envía primero el adjunto y luego (≥ 1 s después) el texto con botones; cada parte tiene su intención durable antes del POST y a lo sumo un `accepted` en `gate_part_events` (solo inserción, índice único). Un adjunto aceptado u omitido nunca se reenvía (ni si el texto falla); un adjunto con resultado **ambiguo** deja la sesión `UNKNOWN_OUTCOME` y el texto **nunca** se envía; un adjunto rechazado se omite y el texto sí se envía (`attachment_failed`). Las sesiones sin adjunto no cambian. La aplicación nunca descarga la URL del adjunto.
15. **Botones interactivos experimentales retirados.** La API rechaza `interactiveMode` distinto de `none` (o títulos) con `interactive_mode_retired`, el encolado ignora un modo heredado y la cola omite (`SKIPPED`) un payload congelado con respuestas rápidas o con botones postback fuera del follow gate. No los reactives: sus botones no hacen nada al tocarlos.
16. **«Pedir que me sigan» y el adjunto del recurso están RETIRADOS.** Con esta aplicación (solo sondeo), Meta rechazó en vivo el envío posterior al toque (HTTP 403, código 10, subcódigo 2534022, «outside of allowed window»): quien tocaba el botón no recibía nada. Un único interruptor, `FOLLOW_GATE_AVAILABLE = false` en `src/services/follow-gate-rules.ts`, apaga todo: la API rechaza la opción (`follow_gate_retired`) y los adjuntos (`attachment_retired`) y un `PUT` limpia lo guardado; el encolado ignora filas con la opción o un adjunto (mensaje normal, sin sesión); la cola omite (`SKIPPED`, `follow_gate_retired`) un payload congelado con la opción antes de llamar al proveedor; el motor cancela (`CANCELLED`, `follow_gate_retired`) las sesiones `AWAITING_TAP` sin llamar a Meta y no toca las cerradas; la interfaz no muestra la opción. **No lo reactives** (ni con variables de entorno ni cambiando el interruptor) sin detección del toque por webhooks y una verificación en vivo de que Meta acepta el envío. La opción `followGateAvailable` de los servicios existe **solo para las pruebas** del código inactivo. Los invariantes 12-14 describen ese código inactivo y siguen vigentes para él.
17. **Adopción de cuentas huérfanas: solo desde conexiones `disconnected`, con confirmación explícita y conservando el `account_id`.** Una cuenta que ya existe bajo otra conexión solo puede pasar a una conexión nueva si la dueña actual está `disconnected` (incluye las eliminadas) y la coincidencia es única; con dueña activa o coincidencia ambigua se sigue rechazando. Seleccionar sin `confirmed: true` responde `account_adoption_required` y no cambia nada. La adopción solo actualiza `connection_id` y los datos de descubrimiento en una transacción; nunca borra ni reescribe historial, cola ni automatizaciones, y no requiere migración.

## Política de pruebas

- **TDD estricto:** primero escribe una prueba que falle (RED), luego el código mínimo que la haga pasar (GREEN) y después refactoriza. Las pruebas van junto al cambio de comportamiento.
- `npm test` y `npm run typecheck` deben pasar antes de dar un cambio por terminado. Informa el resultado real (número de pruebas y fallos), nunca uno supuesto.
- Las pruebas usan bases de datos temporales y proveedores simulados; nunca deben depender de `./data`, de la red ni de credenciales reales.
- El comportamiento por sistema operativo se prueba con una sonda simulada (`tests/application-lock-platform.test.ts`), no en equipos reales: macOS y Windows nativo no están verificados en un equipo real. Usa `path.join`/`resolve` en las pruebas en lugar de rutas con `/` fijas cuando compares rutas.
- `tests/server.test.ts` levanta el servidor en **modo desarrollo** en un puerto libre aleatorio. Si hay un `npm run dev` corriendo en la misma carpeta, Next.js lo rechaza (`Another next dev server is already running in this directory.`); detén ese servidor de desarrollo antes de ejecutar las pruebas.
- Si cambias la interfaz, recuerda que las capturas del manual se regeneran con `node docs/manual/tools/capture.mjs` (ver [docs/manual/tools/README.md](docs/manual/tools/README.md)), que necesita una compilación al día.

## Documentación

Si cambias un comportamiento visible o un dato técnico (puerto, variables, estados, cadencias, esquema), actualiza en el mismo cambio [README.md](README.md), [docs/REFERENCIA-TECNICA.md](docs/REFERENCIA-TECNICA.md) y, si afecta la instalación, [docs/INSTALACION-CON-IA.md](docs/INSTALACION-CON-IA.md). La documentación está en español; los identificadores de código se mantienen en inglés.
