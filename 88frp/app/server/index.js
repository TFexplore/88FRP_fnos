const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const { fetchRemoteConfig, validateConfigText } = require("./lib/config-service");
const { ProcessManager } = require("./lib/process-manager");
const { Router, readJsonBody, sendJson, sendText } = require("./lib/router");
const { Store } = require("./lib/store");

const serverDir = __dirname;
const appDir = process.env.FNOS_APPDEST || process.env.TRIM_APPDEST || path.resolve(serverDir, "..");
const uiDir = path.join(appDir, "ui");
const dataDir = process.env.FNOS_PKGVAR || process.env.TRIM_PKGVAR || path.join(serverDir, "data");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.web_port || process.env.PORT || process.env.TRIM_SERVICE_PORT || 8801);
const defaultRemoteUrl = process.env.remote_url || "";
const frpcBinaryPath =
  process.env.FRPC_BINARY_PATH ||
  path.join(serverDir, "bin", process.platform === "win32" ? "frpc.exe" : "frpc");

const store = new Store({ dataDir });
const logger = {
  info(message) {
    return store.appendAppLog(`[${new Date().toISOString()}] [INFO] ${message}`);
  },
  warn(message) {
    return store.appendAppLog(`[${new Date().toISOString()}] [WARN] ${message}`);
  },
  error(message) {
    return store.appendAppLog(`[${new Date().toISOString()}] [ERROR] ${message}`);
  },
};
const processManager = new ProcessManager({
  store,
  logger,
  frpcBinaryPath,
});
const router = new Router();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function pickInstancePayload(payload) {
  return {
    name: payload.name,
    remark: payload.remark || "",
    source: payload.source || "manual",
    remoteUrl: payload.remoteUrl || "",
    secretKey: payload.secretKey || "",
    method: payload.method || "POST",
    secretPlacement: payload.secretPlacement || "body",
    secretField: payload.secretField || "secret",
    extraHeadersText: payload.extraHeadersText || "{\n  \"Content-Type\": \"application/json\"\n}",
    extraBody: payload.extraBody || "",
    responseMode: payload.responseMode || "text",
    responsePath: payload.responsePath || "",
  };
}

async function ensureInstanceExists(instanceId) {
  const instance = await store.getInstance(instanceId);
  if (!instance) {
    const error = new Error("实例不存在。");
    error.statusCode = 404;
    throw error;
  }
  return instance;
}

async function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  let targetPath = path.join(uiDir, safePath);

  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      targetPath = path.join(targetPath, "index.html");
    }
  } catch (error) {
    targetPath = path.join(uiDir, "index.html");
  }

  try {
    const content = await fs.readFile(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch (error) {
    sendText(res, 404, "Not Found");
  }
}

router.register("GET", "/api/health", async (_req, res) => {
  await processManager.hydrateRuntimeState();
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: {
      service: "88frp",
      nodeVersion: process.version,
      host,
      port,
      dataDir,
      frpc: processManager.getBinaryStatus(),
    },
  });
});

router.register("GET", "/api/settings", async (_req, res) => {
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: await store.getSettings(),
  });
});

router.register("PUT", "/api/settings", async (req, res) => {
  const body = await readJsonBody(req);
  const nextValue = await store.saveSettings({
    apiTimeout: Number(body.apiTimeout || 10000),
    defaultMethod: body.defaultMethod || "POST",
    defaultSecretPlacement: body.defaultSecretPlacement || "body",
    defaultSecretField: body.defaultSecretField || "secret",
    defaultResponseMode: body.defaultResponseMode || "text",
    defaultResponsePath: body.defaultResponsePath || "",
    defaultHeadersText: body.defaultHeadersText || "{\n  \"Content-Type\": \"application/json\"\n}",
    defaultRemoteUrl: body.defaultRemoteUrl || "https://auth.88frp.com/config?secret={{secret}}",
    pollInterval: Number(body.pollInterval || 5000),
  });
  sendJson(res, 200, { success: true, message: "设置已保存。", data: nextValue });
});

router.register("GET", "/api/instances", async (_req, res) => {
  await processManager.hydrateRuntimeState();
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: await store.listInstances(),
  });
});

router.register("POST", "/api/instances", async (req, res) => {
  const body = await readJsonBody(req);
  if (!String(body.name || "").trim()) {
    sendJson(res, 400, { success: false, message: "实例名称不能为空。", data: null });
    return;
  }

  const instance = await store.createInstance(pickInstancePayload(body));
  sendJson(res, 201, {
    success: true,
    message: "实例已创建。",
    data: instance,
  });
});

router.register("GET", "/api/instances/:id", async (_req, res, context) => {
  const instance = await ensureInstanceExists(context.params.id);
  sendJson(res, 200, { success: true, message: "ok", data: instance });
});

router.register("PUT", "/api/instances/:id", async (req, res, context) => {
  const body = await readJsonBody(req);
  const instance = await store.updateInstance(context.params.id, pickInstancePayload(body));
  if (!instance) {
    sendJson(res, 404, { success: false, message: "实例不存在。", data: null });
    return;
  }

  sendJson(res, 200, { success: true, message: "实例信息已更新。", data: instance });
});

router.register("DELETE", "/api/instances/:id", async (_req, res, context) => {
  const instance = await store.getInstance(context.params.id);
  if (instance) {
    await logger.info(`准备删除实例: ${instance.name} (${instance.id})`);
    // 1. 先停止进程
    await processManager.stop(instance.id);
    // 2. 从持久化存储中删除
    const success = await store.deleteInstance(context.params.id);
    await logger.info(`实例 ${instance.name} 已从存储中移除。`);
    sendJson(res, 200, { success, message: success ? "实例已删除并停止。" : "删除失败。", data: null });
  } else {
    sendJson(res, 404, { success: false, message: "实例不存在。", data: null });
  }
});

router.register("GET", "/api/instances/:id/config", async (_req, res, context) => {
  await ensureInstanceExists(context.params.id);
  const configText = await store.readConfig(context.params.id);
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: {
      configText,
      validation: validateConfigText(configText),
    },
  });
});

router.register("PUT", "/api/instances/:id/config", async (req, res, context) => {
  await ensureInstanceExists(context.params.id);
  const body = await readJsonBody(req);
  const configText = String(body.configText || "");
  const validation = validateConfigText(configText);
  if (!validation.valid) {
    sendJson(res, 400, {
      success: false,
      message: validation.errors.join(" "),
      data: validation,
    });
    return;
  }

  await store.saveConfig(context.params.id, configText);
  await store.saveRuntime(context.params.id, {
    ...(await store.getRuntime(context.params.id)),
    updatedAt: new Date().toISOString(),
  });
  sendJson(res, 200, {
    success: true,
    message: validation.warnings[0] || "配置已保存。",
    data: validation,
  });
});

router.register("POST", "/api/instances/:id/fetch-config", async (req, res, context) => {
  const body = await readJsonBody(req);
  const instance = await ensureInstanceExists(context.params.id);
  const settings = await store.getSettings();
  if (defaultRemoteUrl && !settings.defaultRemoteUrl) {
    settings.defaultRemoteUrl = defaultRemoteUrl;
  }
  const nextPayload = {
    ...instance,
    ...body,
  };
  const result = await fetchRemoteConfig(nextPayload, settings);
  if (!result.validation.valid) {
    sendJson(res, 400, {
      success: false,
      message: result.validation.errors.join(" "),
      data: result.validation,
    });
    return;
  }

  await store.saveConfig(instance.id, result.configText);
  const updated = await store.updateInstance(instance.id, pickInstancePayload(nextPayload));
  sendJson(res, 200, {
    success: true,
    message: result.validation.warnings[0] || "远程配置已获取并保存。",
    data: {
      instance: updated,
      configText: result.configText,
      validation: result.validation,
    },
  });
});

router.register("POST", "/api/instances/:id/start", async (_req, res, context) => {
  const instance = await ensureInstanceExists(context.params.id);
  const runtime = await processManager.start(instance);
  sendJson(res, 200, { success: true, message: "启动指令已发送。", data: runtime });
});

router.register("POST", "/api/instances/:id/stop", async (_req, res, context) => {
  await ensureInstanceExists(context.params.id);
  const runtime = await processManager.stop(context.params.id);
  sendJson(res, 200, { success: true, message: "停止指令已发送。", data: runtime });
});

router.register("POST", "/api/instances/:id/restart", async (_req, res, context) => {
  const instance = await ensureInstanceExists(context.params.id);
  const runtime = await processManager.restart(instance);
  sendJson(res, 200, { success: true, message: "重启指令已发送。", data: runtime });
});

router.register("GET", "/api/instances/:id/status", async (_req, res, context) => {
  await ensureInstanceExists(context.params.id);
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: await store.getRuntime(context.params.id),
  });
});

router.register("GET", "/api/instances/:id/logs", async (_req, res, context) => {
  await ensureInstanceExists(context.params.id);
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: {
      content: await store.readInstanceLog(context.params.id),
    },
  });
});

router.register("GET", "/api/logs/app", async (_req, res) => {
  sendJson(res, 200, {
    success: true,
    message: "ok",
    data: {
      text: await store.readAppLog(),
    },
  });
});

async function requestListener(req, res) {
  try {
    if (req.url.startsWith("/api/")) {
      const handled = await router.handle(req, res, {});
      if (!handled) {
        sendJson(res, 404, { success: false, message: "接口不存在。", data: null });
      }
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    await logger.error(error.stack || error.message);
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      success: false,
      message: error.message || "服务内部错误。",
      data: null,
    });
  }
}

async function bootstrap() {
  await store.initialize();
  await processManager.hydrateRuntimeState();
  const server = http.createServer(requestListener);

  server.listen(port, host, async () => {
    await logger.info(`88frp manager started on port ${port}`);
    console.log(`88frp manager listening on http://${host}:${port}`);
  });

  const shutdown = async () => {
    await logger.warn("收到退出信号，准备停止全部实例。");
    await processManager.stopAll();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch(async (error) => {
  await logger.error(error.stack || error.message);
  console.error(error);
  process.exit(1);
});
