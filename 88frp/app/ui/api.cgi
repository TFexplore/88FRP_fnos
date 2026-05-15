#!/bin/bash

CONFIG_FILE="${TRIM_PKGETC}/server.env"
DEFAULT_PORT="${TRIM_SERVICE_PORT:-8801}"
SERVICE_HOST="127.0.0.1"

if [ -f "${CONFIG_FILE}" ]; then
    # shellcheck disable=SC1090
    . "${CONFIG_FILE}"
fi

SERVICE_PORT="${web_port:-$DEFAULT_PORT}"

if ! command -v curl >/dev/null 2>&1; then
    echo "Status: 500 Internal Server Error"
    echo "Content-Type: application/json; charset=utf-8"
    echo ""
    echo '{"success":false,"message":"系统缺少 curl，无法代理 API 请求。","data":null}'
    exit 0
fi

URI_NO_QUERY="${REQUEST_URI%%\?*}"
QUERY_STRING_PART="${REQUEST_URI#*\?}"
REL_PATH="/"

case "${URI_NO_QUERY}" in
    *api.cgi*)
        # 提取 api.cgi 之后的部分，并确保以 / 开头
        REL_PATH="/${URI_NO_QUERY#*api.cgi}"
        REL_PATH="$(echo "${REL_PATH}" | sed 's|//*|/|g')"
        ;;
esac

if [ -z "${REL_PATH}" ] || [ "${REL_PATH}" = "/" ]; then
    REL_PATH="/api/health"
fi

TARGET_URL="http://${SERVICE_HOST}:${SERVICE_PORT}${REL_PATH}"
if [ "${QUERY_STRING_PART}" != "${REQUEST_URI}" ]; then
    TARGET_URL="${TARGET_URL}?${QUERY_STRING_PART}"
fi

HEADER_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
REQUEST_BODY_FILE="$(mktemp)"
cleanup() {
    rm -f "${HEADER_FILE}" "${BODY_FILE}" "${REQUEST_BODY_FILE}"
}
trap cleanup EXIT

if [ "${REQUEST_METHOD}" != "GET" ] && [ "${REQUEST_METHOD}" != "HEAD" ]; then
    cat > "${REQUEST_BODY_FILE}"
fi

CURL_ARGS=(
    -sS
    -X "${REQUEST_METHOD:-GET}"
    -D "${HEADER_FILE}"
    -o "${BODY_FILE}"
    -H "Accept: application/json"
)

if [ -n "${CONTENT_TYPE}" ]; then
    CURL_ARGS+=(-H "Content-Type: ${CONTENT_TYPE}")
fi

if [ -s "${REQUEST_BODY_FILE}" ]; then
    CURL_ARGS+=(--data-binary "@${REQUEST_BODY_FILE}")
fi

if ! curl "${CURL_ARGS[@]}" "${TARGET_URL}"; then
    echo "Status: 502 Bad Gateway"
    echo "Content-Type: application/json; charset=utf-8"
    echo ""
    echo '{"success":false,"message":"88FRP 内部管理服务不可用。","data":null}'
    exit 0
fi

STATUS_LINE="$(head -n 1 "${HEADER_FILE}" | tr -d '\r')"
STATUS_CODE="$(echo "${STATUS_LINE}" | awk '{print $2}')"
STATUS_TEXT="$(echo "${STATUS_LINE}" | cut -d' ' -f3-)"

if [ -z "${STATUS_CODE}" ]; then
    STATUS_CODE="200"
    STATUS_TEXT="OK"
fi

echo "Status: ${STATUS_CODE} ${STATUS_TEXT}"
while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -z "${line}" ] && continue
    case "${line}" in
        HTTP/*|Transfer-Encoding:*|Connection:*)
            continue
            ;;
    esac
    echo "${line}"
done < "${HEADER_FILE}"
echo ""
cat "${BODY_FILE}"
