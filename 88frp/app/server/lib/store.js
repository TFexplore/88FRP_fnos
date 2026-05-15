const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_SETTINGS = {
  apiTimeout: 10000,
  defaultMethod: "POST",
  defaultSecretPlacement: "body",
  defaultSecretField: "secret",
  defaultResponseMode: "text",
  defaultResponsePath: "",
  defaultHeadersText: "{\n  \"Content-Type\": \"application/json\"\n}",
  pollInterval: 5000,
};

const DEFAULT_RUNTIME = {
  status: "stopped",
  pid: null,
  lastExitCode: null,
  lastStartedAt: "",
  lastError: "",
  updatedAt: "",
};

class Store {
  constructor(options) {
    this.dataDir = options.dataDir;
    this.instancesFile = path.join(this.dataDir, "instances.json");
    this.settingsFile = path.join(this.dataDir, "settings.json");
    this.appLogFile = path.join(this.dataDir, "app.log");
    this.instancesDir = path.join(this.dataDir, "instances");
  }

  async initialize() {
    await fsp.mkdir(this.instancesDir, { recursive: true });
    await this.ensureJsonFile(this.instancesFile, []);
    await this.ensureJsonFile(this.settingsFile, DEFAULT_SETTINGS);
    await this.ensureTextFile(this.appLogFile, "");
  }

  async ensureJsonFile(filePath, fallbackValue) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch (error) {
      await this.writeJson(filePath, fallbackValue);
    }
  }

  async ensureTextFile(filePath, fallbackValue) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
    } catch (error) {
      await fsp.writeFile(filePath, fallbackValue, "utf8");
    }
  }

  async readJson(filePath, fallbackValue) {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      return fallbackValue;
    }
  }

  async writeJson(filePath, value) {
    await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  }

  async listInstances() {
    const instances = await this.readJson(this.instancesFile, []);
    const items = await Promise.all(
      instances.map(async (instance) => {
        const runtime = await this.getRuntime(instance.id);
        const configPath = this.getConfigPath(instance.id);
        const hasConfig = await this.fileExists(configPath);
        return {
          ...instance,
          runtime,
          hasConfig,
        };
      })
    );
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getInstance(instanceId) {
    const instances = await this.readJson(this.instancesFile, []);
    const instance = instances.find((item) => item.id === instanceId);
    if (!instance) {
      return null;
    }

    return {
      ...instance,
      runtime: await this.getRuntime(instance.id),
      configText: await this.readConfig(instance.id),
      hasConfig: await this.fileExists(this.getConfigPath(instance.id)),
    };
  }

  async createInstance(payload) {
    const instances = await this.readJson(this.instancesFile, []);
    const now = new Date().toISOString();
    const instance = {
      id: crypto.randomUUID(),
      name: payload.name.trim(),
      remark: payload.remark || "",
      source: payload.source || "manual",
      remoteUrl: payload.remoteUrl || "",
      secretKey: payload.secretKey || "",
      method: payload.method || "POST",
      secretPlacement: payload.secretPlacement || "body",
      secretField: payload.secretField || "secret",
      extraHeadersText:
        payload.extraHeadersText || DEFAULT_SETTINGS.defaultHeadersText,
      extraBody: payload.extraBody || "",
      responseMode: payload.responseMode || "text",
      responsePath: payload.responsePath || "",
      createdAt: now,
      updatedAt: now,
    };

    instances.push(instance);
    await this.writeJson(this.instancesFile, instances);
    await this.ensureInstanceDirectory(instance.id);
    await this.saveRuntime(instance.id, { ...DEFAULT_RUNTIME, updatedAt: now });
    await this.ensureTextFile(this.getLogPath(instance.id), "");
    return this.getInstance(instance.id);
  }

  async updateInstance(instanceId, payload) {
    const instances = await this.readJson(this.instancesFile, []);
    const index = instances.findIndex((item) => item.id === instanceId);
    if (index < 0) {
      return null;
    }

    const current = instances[index];
    const updated = {
      ...current,
      ...payload,
      name: (payload.name || current.name).trim(),
      updatedAt: new Date().toISOString(),
    };
    instances[index] = updated;
    await this.writeJson(this.instancesFile, instances);
    return this.getInstance(instanceId);
  }

  async deleteInstance(instanceId) {
    const instances = await this.readJson(this.instancesFile, []);
    const nextItems = instances.filter((item) => item.id !== instanceId);
    if (nextItems.length === instances.length) {
      return false;
    }

    await this.writeJson(this.instancesFile, nextItems);
    await fsp.rm(this.getInstanceDir(instanceId), { recursive: true, force: true });
    return true;
  }

  async getSettings() {
    return this.readJson(this.settingsFile, DEFAULT_SETTINGS);
  }

  async saveSettings(payload) {
    const current = await this.getSettings();
    const nextValue = {
      ...current,
      ...payload,
    };
    await this.writeJson(this.settingsFile, nextValue);
    return nextValue;
  }

  async readConfig(instanceId) {
    try {
      return await fsp.readFile(this.getConfigPath(instanceId), "utf8");
    } catch (error) {
      return "";
    }
  }

  async saveConfig(instanceId, configText) {
    await this.ensureInstanceDirectory(instanceId);
    await fsp.writeFile(this.getConfigPath(instanceId), configText, "utf8");
  }

  async getRuntime(instanceId) {
    return this.readJson(this.getRuntimePath(instanceId), DEFAULT_RUNTIME);
  }

  async saveRuntime(instanceId, runtime) {
    await this.ensureInstanceDirectory(instanceId);
    const nextValue = {
      ...DEFAULT_RUNTIME,
      ...runtime,
      updatedAt: runtime.updatedAt || new Date().toISOString(),
    };
    await this.writeJson(this.getRuntimePath(instanceId), nextValue);
    return nextValue;
  }

  async appendLog(instanceId, line) {
    await this.ensureInstanceDirectory(instanceId);
    await fsp.appendFile(this.getLogPath(instanceId), `${line}\n`, "utf8");
  }

  async appendAppLog(line) {
    await fsp.appendFile(this.appLogFile, `${line}\n`, "utf8");
  }

  async readLogTail(filePath, lineLimit = 200) {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      return raw.split(/\r?\n/).filter(Boolean).slice(-lineLimit).join("\n");
    } catch (error) {
      return "";
    }
  }

  async readInstanceLog(instanceId, lineLimit = 200) {
    return this.readLogTail(this.getLogPath(instanceId), lineLimit);
  }

  async readAppLog(lineLimit = 200) {
    return this.readLogTail(this.appLogFile, lineLimit);
  }

  getConfigPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "frpc.toml");
  }

  getRuntimePath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "runtime.json");
  }

  getLogPath(instanceId) {
    return path.join(this.getInstanceDir(instanceId), "runtime.log");
  }

  getInstanceDir(instanceId) {
    return path.join(this.instancesDir, instanceId);
  }

  async ensureInstanceDirectory(instanceId) {
    await fsp.mkdir(this.getInstanceDir(instanceId), { recursive: true });
  }

  async fileExists(filePath) {
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = {
  Store,
  DEFAULT_SETTINGS,
  DEFAULT_RUNTIME,
};
