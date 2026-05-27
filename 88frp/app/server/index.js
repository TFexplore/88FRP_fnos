const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
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
const gatewaySocketName = path.basename(process.env.GATEWAY_SOCKET || process.env.gatewaySocket || "88frp.sock");
const gatewayPrefix = normalizeGatewayPrefix(process.env.GATEWAY_PREFIX || process.env.gatewayPrefix || "/app/88frp");
const socketDir = appDir;
const socketPath = path.join(appDir, gatewaySocketName);
const listenMode = process.env.LISTEN_MODE || (process.platform === "win32" ? "port" : "socket");
const autoSyncIntervalMs = Math.max(60000, Number(process.env.AUTO_SYNC_INTERVAL_MS || 60000));
const autoStartInstancesOnBoot = String(process.env.INSTANCE_AUTO_START_ON_BOOT || "1") !== "0";

const getArchDir = () => {
  switch (process.arch) {
    case "x64": return "amd64";
    case "arm64": return "arm64";
    case "arm": return "arm";
    default: return process.arch;
  }
};

const getFrpcPath = () => {
  if (process.env.FRPC_BINARY_PATH) return process.env.FRPC_BINARY_PATH;
  
  const archDir = getArchDir();
  const binaryName = "88frpc";
  
  // 优先尝试架构特定目录
  const archPath = path.join(serverDir, "bin", archDir, binaryName);
  if (fsSync.existsSync(archPath)) return archPath;
  
  // 回退到原有的 bin 目录
  return path.join(serverDir, "bin", binaryName);
};

const frpcBinaryPath = getFrpcPath();

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

function normalizeGatewayPrefix(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const prefixed = text.startsWith("/") ? text : `/${text}`;
  return prefixed.replace(/\/+$/, "");
}

function buildGatewayLocation(rawUrl) {
  const requestUrl = new URL(rawUrl, "http://127.0.0.1");
  return `${gatewayPrefix}/${requestUrl.search}`;
}

function normalizeGatewayRequestUrl(rawUrl) {
  if (!gatewayPrefix) {
    return rawUrl;
  }

  const requestUrl = new URL(rawUrl, "http://127.0.0.1");
  if (requestUrl.pathname === gatewayPrefix) {
    requestUrl.pathname = "/";
    return `${requestUrl.pathname}${requestUrl.search}`;
  }

  if (!requestUrl.pathname.startsWith(`${gatewayPrefix}/`)) {
    return rawUrl;
  }

  requestUrl.pathname = requestUrl.pathname.slice(gatewayPrefix.length) || "/";
  return `${requestUrl.pathname}${requestUrl.search}`;
}

function pickInstancePayload(payload) {
  const partial = Boolean(payload && payload.__partial);
  const nextValue = {};
  const addField = (key, value) => {
    if (!partial || Object.prototype.hasOwnProperty.call(payload, key)) {
      nextValue[key] = value;
    }
  };

  addField("name", payload.name);
  addField("remark", payload.remark || "");
  addField("source", payload.source || "manual");
  addField("remoteUrl", payload.remoteUrl || "");
  addField("secretKey", payload.secretKey || "");
  addField("method", payload.method || "POST");
  addField("secretPlacement", payload.secretPlacement || "body");
  addField("secretField", payload.secretField || "secret");
  addField("extraHeadersText", payload.extraHeadersText || "{\n  \"Content-Type\": \"application/json\"\n}");
  addField("extraBody", payload.extraBody || "");
  addField("responseMode", payload.responseMode || "text");
  addField("responsePath", payload.responsePath || "");
  addField("autoSyncEnabled", Boolean(payload.autoSyncEnabled));
  return nextValue;
}

function normalizeConfigForCompare(configText) {
  return String(configText || "").replace(/\r\n/g, "\n").trimEnd();
}

async function resolveSyncSettings() {
  const settings = await store.getSettings();
  if (defaultRemoteUrl && !settings.defaultRemoteUrl) {
    settings.defaultRemoteUrl = defaultRemoteUrl;
  }
  return settings;
}

async function fetchInstanceRemoteConfig(instance) {
  const settings = await resolveSyncSettings();
  let result;
  try {
    result = await fetchRemoteConfig(instance, settings);
  } catch (error) {
    error.statusCode = error.statusCode || 502;
    throw error;
  }

  if (!result.validation.valid) {
    const error = new Error(result.validation.errors.join(" "));
    error.statusCode = 400;
    throw error;
  }

  const currentConfigText = await store.readConfig(instance.id);
  return {
    ...result,
    changed: normalizeConfigForCompare(currentConfigText) !== normalizeConfigForCompare(result.configText),
  };
}

async function saveInstanceConfig(instanceId, configText) {
  await store.saveConfig(instanceId, configText);
  await store.saveRuntime(instanceId, {
    ...(await store.getRuntime(instanceId)),
    updatedAt: new Date().toISOString(),
  });
}

async function applyRemoteConfig(instance, options = {}) {
  const result = await fetchInstanceRemoteConfig(instance);
  if (!result.changed) {
    return {
      ...result,
      runtimeAction: "unchanged",
    };
  }

  await saveInstanceConfig(instance.id, result.configText);

  if (!options.restartOnChange) {
    return {
      ...result,
      runtimeAction: "saved",
    };
  }

  const latestInstance = await ensureInstanceExists(instance.id);
  const runtime = await store.getRuntime(instance.id);
  if (runtime.pid && processManager.checkPid(runtime.pid)) {
    await processManager.restart(latestInstance);
    return {
      ...result,
      runtimeAction: "restarted",
    };
  }

  await processManager.start(latestInstance);
  return {
    ...result,
    runtimeAction: "started",
  };
}

async function autoStartManagedInstances() {
  if (!autoStartInstancesOnBoot) {
    await logger.info("已跳过实例自动启动。");
    return;
  }

  const instances = await store.listInstances();
  for (const instance of instances) {
    try {
      const configText = await store.readConfig(instance.id);
      if (!configText.trim()) {
        await logger.warn(`实例 ${instance.name} 未配置内容，跳过自动启动。`);
        continue;
      }

      const runtime = await store.getRuntime(instance.id);
      if (runtime.pid && processManager.checkPid(runtime.pid)) {
        continue;
      }

      await logger.info(`服务启动后自动启动实例: ${instance.name}`);
      await processManager.start(instance);
    } catch (error) {
      await logger.error(`自动启动实例 ${instance.name} 失败: ${error.message}`);
    }
  }
}

function startAutoSyncScheduler() {
  let running = false;

  return setInterval(async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const instances = await store.listInstances();
      const targets = instances.filter((instance) => instance.autoSyncEnabled);
      for (const instance of targets) {
        try {
          if (!String(instance.secretKey || "").trim()) {
            await logger.warn(`实例 ${instance.name} 已开启自动同步，但未配置密匙，已跳过。`);
            continue;
          }

          const result = await applyRemoteConfig(instance, { restartOnChange: true });
          if (result.changed) {
            await logger.info(`实例 ${instance.name} 自动同步检测到配置变更，已${result.runtimeAction === "restarted" ? "重启" : "启动"}实例。`);
          }
        } catch (error) {
          await logger.error(`实例 ${instance.name} 自动同步失败: ${error.message}`);
        }
      }
    } finally {
      running = false;
    }
  }, autoSyncIntervalMs);
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
      listenMode,
      host,
      port,
      socketPath,
      gatewayPrefix,
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
  if (Object.prototype.hasOwnProperty.call(body, "name") && !String(body.name || "").trim()) {
    sendJson(res, 400, { success: false, message: "实例名称不能为空。", data: null });
    return;
  }

  const instance = await store.updateInstance(context.params.id, pickInstancePayload({
    ...body,
    __partial: true,
  }));
  if (!instance) {
    sendJson(res, 404, { success: false, message: "实例不存在。", data: null });
    return;
  }

  sendJson(res, 200, { success: true, message: "实例信息已更新。", data: instance });
});

router.register("DELETE", "/api/instances/:id", async (_req, res, context) => {
  const instance = await store.getInstance(context.params.id);
  if (!instance) {
    sendJson(res, 404, { success: false, message: "实例不存在。", data: null });
    return;
  }

  const runtime = await store.getRuntime(instance.id);
  await logger.info(`准备删除实例: ${instance.name} (${instance.id})`);

  if (runtime.pid && processManager.checkPid(runtime.pid)) {
    await logger.info(`删除前先暂停实例: ${instance.name}`);
    await processManager.stop(instance.id);
  }

  const success = await store.deleteInstance(context.params.id);
  await logger.info(`实例 ${instance.name} 已从存储中移除。`);
  sendJson(res, 200, { success, message: success ? "实例已先暂停并删除。" : "删除失败。", data: null });
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

  await saveInstanceConfig(context.params.id, configText);
  sendJson(res, 200, {
    success: true,
    message: validation.warnings[0] || "配置已保存。",
    data: validation,
  });
});

router.register("POST", "/api/instances/:id/fetch-config", async (req, res, context) => {
  const body = await readJsonBody(req);
  const instance = await ensureInstanceExists(context.params.id);
  const nextPayload = {
    ...instance,
    ...body,
  };
  const updated = await store.updateInstance(instance.id, pickInstancePayload(nextPayload));
  const result = await applyRemoteConfig(updated, { restartOnChange: false });
  sendJson(res, 200, {
    success: true,
    message: result.changed
      ? (result.validation.warnings[0] || "远程配置已获取并保存。")
      : "远程配置无变化。",
    data: {
      instance: updated,
      configText: result.configText,
      validation: result.validation,
      changed: result.changed,
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
    const rawPath = req.url.split("?")[0];
    if (gatewayPrefix && rawPath === gatewayPrefix) {
      res.writeHead(302, {
        Location: buildGatewayLocation(req.url),
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    req.url = normalizeGatewayRequestUrl(req.url);
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
  await fs.mkdir(socketDir, { recursive: true });
  // 在启动时清理幽灵进程
  await processManager.killGhostProcesses();
  await processManager.hydrateRuntimeState();
  await autoStartManagedInstances();
  const autoSyncTimer = startAutoSyncScheduler();
  const server = http.createServer(requestListener);
  const isSocketMode = listenMode === "socket";

  if (isSocketMode) {
    try {
      await fs.unlink(socketPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (isSocketMode) {
    server.listen(socketPath, async () => {
      try {
        await fs.chmod(socketPath, 0o666);
      } catch (error) {
        await logger.warn(`设置 socket 权限失败: ${error.message}`);
      }
      await logger.info(`88frp manager started on socket ${socketPath}`);
      console.log(`88frp manager listening on socket ${socketPath}`);
    });
  } else {
    server.listen(port, host, async () => {
      await logger.info(`88frp manager started on port ${port}`);
      console.log(`88frp manager listening on http://${host}:${port}`);
    });
  }

  const shutdown = async () => {
    await logger.warn("收到退出信号，准备停止全部实例。");
    clearInterval(autoSyncTimer);
    await processManager.stopAll();
    server.close(async () => {
      if (isSocketMode) {
        try {
          await fs.unlink(socketPath);
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.error(error);
          }
        }
      }
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
