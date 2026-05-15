const { URL } = require("url");

function compileRoute(routePath) {
  const keys = [];
  const pattern = routePath
    .replace(/\//g, "\\/")
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return "([^\\/]+)";
    });

  return {
    keys,
    regex: new RegExp(`^${pattern}$`),
  };
}

class Router {
  constructor() {
    this.routes = [];
  }

  register(method, routePath, handler) {
    const compiled = compileRoute(routePath);
    this.routes.push({
      method,
      routePath,
      handler,
      ...compiled,
    });
  }

  async handle(req, res, context) {
    const requestUrl = new URL(req.url, "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    for (const route of this.routes) {
      if (route.method !== req.method) {
        continue;
      }

      const matched = pathname.match(route.regex);
      if (!matched) {
        continue;
      }

      const params = route.keys.reduce((accumulator, key, index) => {
        accumulator[key] = decodeURIComponent(matched[index + 1]);
        return accumulator;
      }, {});

      await route.handler(req, res, {
        ...context,
        params,
        query: Object.fromEntries(requestUrl.searchParams.entries()),
        pathname,
      });
      return true;
    }

    return false;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

module.exports = {
  Router,
  readJsonBody,
  sendJson,
  sendText,
};
