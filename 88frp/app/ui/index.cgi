#!/bin/bash

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BASE_PATH="${TRIM_APPDEST:+${TRIM_APPDEST}/ui}"

if [ -z "${BASE_PATH}" ]; then
    BASE_PATH="${SCRIPT_DIR}"
fi

URI_NO_QUERY="${REQUEST_URI%%\?*}"
REL_PATH="/"

case "${URI_NO_QUERY}" in
    *index.cgi*)
        REL_PATH="${URI_NO_QUERY#*index.cgi}"
        ;;
esac

if [ -z "${REL_PATH}" ] || [ "${REL_PATH}" = "/" ]; then
    REL_PATH="/index.html"
fi

TARGET_FILE="${BASE_PATH}${REL_PATH}"
TARGET_DIR="$(dirname -- "${TARGET_FILE}")"
RESOLVED_DIR="$(CDPATH= cd -- "${TARGET_DIR}" 2>/dev/null && pwd)"

# 修复校验逻辑：使用 case 进行前缀匹配，防止目录穿越
case "${RESOLVED_DIR}/" in
    "${BASE_PATH}/"*)
        ;;
    *)
        echo "Status: 400 Bad Request"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "Bad Request: Access Denied"
        exit 0
        ;;
esac

if [ ! -f "${TARGET_FILE}" ]; then
    echo "Status: 404 Not Found"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "404 Not Found"
    exit 0
fi

case "${TARGET_FILE##*.}" in
    html|htm)
        MIME_TYPE="text/html; charset=utf-8"
        ;;
    css)
        MIME_TYPE="text/css; charset=utf-8"
        ;;
    js)
        MIME_TYPE="application/javascript; charset=utf-8"
        ;;
    json)
        MIME_TYPE="application/json; charset=utf-8"
        ;;
    png)
        MIME_TYPE="image/png"
        ;;
    svg)
        MIME_TYPE="image/svg+xml"
        ;;
    txt|log)
        MIME_TYPE="text/plain; charset=utf-8"
        ;;
    *)
        MIME_TYPE="application/octet-stream"
        ;;
esac

echo "Content-Type: ${MIME_TYPE}"
echo "Cache-Control: no-store"
echo ""
cat "${TARGET_FILE}"
