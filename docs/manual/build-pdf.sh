#!/usr/bin/env bash
# Genera docs/manual/Manual-Social-Desk.pdf a partir de manual.html con Chrome headless.
# Uso: bash docs/manual/build-pdf.sh [ruta-de-salida.pdf]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTPUT="${1:-${REPO_ROOT}/docs/manual/Manual-Social-Desk.pdf}"
CHROME="${CHROME:-google-chrome}"

if ! command -v "${CHROME}" >/dev/null 2>&1; then
  echo "No se encontró ${CHROME}. Instala Google Chrome o define CHROME=/ruta/al/navegador." >&2
  exit 1
fi

missing=0
for image in "${SCRIPT_DIR}"/images/{01..21}-*.png; do
  [ -e "${image}" ] || missing=$((missing + 1))
done
if [ ! -d "${SCRIPT_DIR}/images" ] || [ "${missing}" -gt 0 ]; then
  echo "Aviso: faltan capturas en ${SCRIPT_DIR}/images; el PDF se generará sin ellas." >&2
fi

"${CHROME}" --headless=new --no-sandbox --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="${OUTPUT}" "file://${SCRIPT_DIR}/manual.html"

echo "PDF generado: ${OUTPUT}"
