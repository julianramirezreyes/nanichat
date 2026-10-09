# Instalador de Social Desk para Windows

Esta carpeta produce `SocialDesk-Setup-<versión>.exe`: un instalador para personas sin conocimientos técnicos. Incluye su propio Node.js, la aplicación ya compilada y accesos directos; no hace falta instalar Node, git ni npm. Lo compila y lo prueba GitHub Actions en un Windows real ([`.github/workflows/windows-installer.yml`](../../.github/workflows/windows-installer.yml)).

## Publicar una versión

1. Sube la versión en `package.json` (por ejemplo `0.2.0`) y confírmala en `main`.
2. Crea y sube la etiqueta: `git tag v0.2.0 && git push origin v0.2.0`.
3. El flujo compila el instalador, ejecuta la prueba de humo y crea (o actualiza) la *Release* `v0.2.0` con el `.exe`, `SHA256SUMS.txt` y notas en español.

La etiqueta **debe** coincidir con la versión de `package.json`; si no, el flujo falla al principio. También se puede lanzar a mano (*Run workflow*) o se lanza solo al cambiar `packaging/**` en `main`: en esos casos produce el instalador como artefacto, sin publicar nada.

## Qué contiene

```text
%LOCALAPPDATA%\Programs\SocialDesk\        programa (se borra al desinstalar)
  node\node.exe                            Node.js portátil oficial (versión = mínimo de engines en package.json)
  app\                                     .next compilado, server.ts, src\, scripts\, node_modules de producción
  launcher\launch.ps1, stop.ps1            abrir y detener (PowerShell 5.1)
  launcher\social-desk.ico                 icono generado en la compilación
  docs\Manual-Social-Desk.pdf              manual de usuario
  VERSION.txt                              versión, commit, versión de Node y fecha

%LOCALAPPDATA%\SocialDesk\                 datos del usuario (NUNCA se borran al desinstalar)
  data\                                    social-automation.sqlite, vault.key, bloqueo de instancia
  logs\                                    launcher.log y server-<fecha>.log / .err.log (se borran a los 14 días)
  run\                                     pid.txt y port.txt de la instancia abierta
```

Accesos directos: **Social Desk** (escritorio, activado por defecto, y menú Inicio), **Detener Social Desk** y **Manual de usuario** (menú Inicio → Social Desk). La instalación es por usuario: no pide permisos de administrador ni escribe en el registro más allá de la entrada de desinstalación.

## Cómo se construye

| Paso | Comando | Qué hace |
| --- | --- | --- |
| 1 | `npm ci`, `npm run build` | Dependencias y compilación de Next.js (`.next`). |
| 2 | `node packaging/windows/fetch-node.mjs` | Descarga `node-v<versión>-win-x64.zip` y `SHASUMS256.txt` de nodejs.org, **verifica el SHA-256** y extrae solo `node.exe` y `LICENSE` en `dist/node-win-x64/`. `PORTABLE_NODE_VERSION` permite otra versión (nunca menor que `engines`). |
| 3 | `node packaging/windows/build-payload.mjs` | Arma `dist/payload/`: copia los archivos de ejecución, instala `npm ci --omit=dev`, poda lo innecesario e informa tamaño y ruta más larga (`dist/payload-report.json`). |
| 4 | `ISCC.exe /DAppVersion=<v> /DPayloadDir=<…> /DOutputDir=<…> packaging\windows\SocialDesk.iss` | Inno Setup 6 empaqueta `dist/payload` en `dist/installer/SocialDesk-Setup-<v>.exe` (LZMA2). |
| 5 | `packaging\windows\test\smoke.ps1 -Installer <exe>` | Prueba de humo (ver abajo). |

Decisiones de tamaño (≈ 215 MB sin comprimir en una prueba en Linux; el objetivo es < 300 MB):

- `tsx` es una dependencia de **producción**: `scripts/start.mjs` la necesita para cargar `server.ts`.
- `next.config.mjs` (no `.ts`): así Next.js no necesita el compilador nativo SWC al arrancar, y el instalador lo omite (≈ 100 MB). Con un `next.config.ts`, Next.js intentaría **descargar** SWC en cada equipo.
- Se podan `sharp`/`@img` (la app no usa `next/image`), mapas de código fuente, declaraciones `.d.ts`, Markdown y `next/dist/docs`. Las licencias se conservan.
- Solo se extrae `node.exe` del zip oficial (sin npm ni corepack). El lector ZIP es Node puro (`lib/zip.mjs`): funciona igual en Windows y Linux, se prueba en `tests/windows-packaging.test.ts` y verifica tamaño y CRC-32 de cada archivo.

## Cómo funciona el lanzador

`launch.ps1` (lo usan los accesos directos con `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File …`):

1. Si la instancia anotada en `run\port.txt` responde en `/api/health`, solo abre el navegador.
2. Si el proceso de `run\pid.txt` es este `node.exe` y sigue arrancando, lo espera en vez de abrir otro.
3. Si el bloqueo de `data\` nombra un PID que ahora es **otro programa** (Windows reutiliza PIDs y la app, sin `/proc`, no puede saberlo), borra ese bloqueo obsoleto. Un bloqueo de un Social Desk vivo nunca se toca.
4. Usa el puerto **3000**; si está ocupado, el primero libre entre **3001 y 3020**.
5. Inicia `node\node.exe app\scripts\start.mjs` oculto, con `LOCAL_SOCIAL_DATA_DIR` y `PORT`, y espera hasta 90 s a `/api/health`. Luego abre `http://localhost:<puerto>`.
6. Si falla, muestra un cuadro de diálogo con la ruta del registro y sus últimas 15 líneas.

`stop.ps1` termina el árbol de procesos con `taskkill /T /F` (Windows no tiene `SIGINT`/`SIGTERM` para un proceso oculto), pero solo procesos cuyo ejecutable es el `node.exe` de esta instalación. SQLite (WAL) tolera el cierre brusco; un envío en curso en ese instante queda `UNKNOWN_OUTCOME`, como ante un corte de luz. Después borra el bloqueo si nombraba el proceso detenido.

Opciones para pruebas: `-NoBrowser`, `-Quiet` (sin diálogos; también `SOCIAL_DESK_NONINTERACTIVE=1`), `-TimeoutSeconds`. `SOCIAL_DESK_HOME` cambia la carpeta base `%LOCALAPPDATA%\SocialDesk` (solo para pruebas).

**¿Por qué no un `.vbs` o `.cmd`?** `-ExecutionPolicy Bypass` en la línea de comandos basta en equipos personales (los archivos instalados no llevan la marca «descargado de internet»). Solo una directiva de grupo corporativa lo impediría, y en ese caso un `.vbs` tampoco ayuda; además Microsoft está retirando VBScript. El costo es que una ventana de PowerShell puede parpadear un instante al abrir.

## Desinstalar y datos

- Panel de control → Aplicaciones → **Social Desk** → Desinstalar (o `unins000.exe`).
- Primero se ejecuta `stop.ps1 -Quiet`, luego se borran **solo** las carpetas del programa (`app`, `node`, `launcher`, `docs`).
- `%LOCALAPPDATA%\SocialDesk\data` (base de datos y `vault.key`) **siempre se conserva**, también en desinstalaciones silenciosas. Al desinstalar con ventana se muestra dónde quedaron. Para borrarlos hay que hacerlo a mano.
- Actualizar = instalar la versión nueva encima (mismo `AppId`): el instalador detiene la versión abierta, reemplaza las carpetas del programa y conserva los datos. **Respalda `data` antes**: la base se migra al arrancar y no se puede volver atrás.

## SmartScreen

El instalador **no está firmado**. Windows mostrará «Windows protegió su PC»: pulsa **Más información → Ejecutar de todas formas**. Comprueba el SHA-256 publicado en la *Release* si quieres verificar la descarga. Firmarlo requiere un certificado de firma de código (no incluido).

## Prueba de humo

La ejecuta CI después de compilar; también se puede correr en un Windows propio:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\test\smoke.ps1 `
  -Installer dist\installer\SocialDesk-Setup-0.1.0.exe -SocialDeskHome "$env:TEMP\sd-smoke-home"
```

Sin `-SocialDeskHome` usa `%LOCALAPPDATA%\SocialDesk` y **se niega a correr** si ya existe `data` (para no tocar una instalación real). Comprueba:

- [ ] instalación silenciosa (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /DIR=… /TASKS=`), archivos y accesos del menú Inicio;
- [ ] `launch.ps1 -NoBrowser`: `/api/health` = `{"status":"ok","ready":true}`, `GET /` = 200, `GET /api/settings/features`;
- [ ] segundo arranque idempotente (mismo PID y puerto, un solo `node.exe`);
- [ ] `social-automation.sqlite` y `vault.key` en la carpeta de datos;
- [ ] `stop.ps1`: puerto cerrado, bloqueo liberado; arranque limpio de nuevo;
- [ ] cierre brusco (`taskkill /F`) y nuevo arranque sobre el bloqueo huérfano;
- [ ] bloqueo con un PID reutilizado por otro programa: el lanzador lo elimina y arranca;
- [ ] desinstalación silenciosa: carpeta del programa borrada, datos conservados.

Imprime `PASS:`/`FAIL:`, muestra el final de los registros si algo falla y sale con código distinto de 0. Los registros quedan en el artefacto `windows-test-logs`.

## Archivos

| Archivo | Para qué |
| --- | --- |
| `fetch-node.mjs` | Descarga y verifica Node.js portátil. |
| `build-payload.mjs` | Arma `dist/payload`. |
| `lib/*.mjs` | Lector ZIP, versión de Node, reglas de poda, icono (probados en `tests/windows-packaging.test.ts`). |
| `launcher/*.ps1` | Abrir y detener (UTF-8 **con BOM**: PowerShell 5.1 lee como ANSI los archivos sin BOM). |
| `SocialDesk.iss` | Script de Inno Setup 6 (UTF-8 con BOM). |
| `test/smoke.ps1` | Prueba de humo de extremo a extremo. |
