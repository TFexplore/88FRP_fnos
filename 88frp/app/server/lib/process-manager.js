const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class ProcessManager {
  constructor(options) {
    this.store = options.store;
    this.logger = options.logger;
    this.frpcBinaryPath = options.frpcBinaryPath;
    this.processMap = new Map();
  }

  async hydrateRuntimeState() {
    const instances = await this.store.readJson(this.store.instancesFile, []);
    await Promise.all(
      instances.map(async (instance) => {
        const runtime = await this.store.getRuntime(instance.id);
        const isAlive = runtime.pid && this.checkPid(runtime.pid);
        
        if (isAlive) {
          if (runtime.status !== "running") {
            await this.store.saveRuntime(instance.id, {
              ...runtime,
              status: "running",
            });
          }
        } else {
          // 如果记录是运行中，但实际没进程了，说明异常退出了
          if (runtime.status === "running" || runtime.status === "starting" || runtime.status === "stopping") {
            await this.store.saveRuntime(instance.id, {
              ...runtime,
              status: "error",
              pid: null,
              lastError: "检测到进程非预期结束 (可能已崩溃或被手动关闭)",
            });
          }
        }
      })
    );
  }

  getBinaryStatus() {
    const exists = fs.existsSync(this.frpcBinaryPath);
    let canExecute = false;
    if (exists) {
      try {
        fs.accessSync(this.frpcBinaryPath, fs.constants.X_OK);
        canExecute = true;
      } catch (e) {
        canExecute = false;
      }
    }
    return {
      path: this.frpcBinaryPath,
      exists,
      canExecute
    };
  }

  async start(instance) {
    const configPath = this.store.getConfigPath(instance.id);
    const configText = await this.store.readConfig(instance.id);
    
    if (!configText.trim()) {
      throw new Error("实例配置为空，请先保存或同步配置。");
    }

    // 确保配置文件确实存在于磁盘
    await this.store.saveConfig(instance.id, configText);

    const binaryStatus = this.getBinaryStatus();
    if (!binaryStatus.exists) {
      throw new Error(`未找到 frpc 可执行文件，请将其放到 ${binaryStatus.path}。`);
    }

    let runtime = await this.store.getRuntime(instance.id);
    if (runtime.pid && this.checkPid(runtime.pid)) {
      runtime = await this.stop(instance.id);
    }

    const logPath = this.store.getLogPath(instance.id);
    
    // 先写入一条启动日志，确保文件被创建
    await this.store.appendLog(instance.id, this.buildLogLine("INFO", `准备启动实例: ${instance.name}`));
    await this.store.appendLog(instance.id, this.buildLogLine("INFO", `运行命令: ${this.frpcBinaryPath} -c ${configPath}`));

    await this.store.saveRuntime(instance.id, {
      ...runtime,
      status: "starting",
      lastError: "",
      updatedAt: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      try {
        const child = spawn(this.frpcBinaryPath, ["-c", configPath], {
          cwd: path.dirname(this.frpcBinaryPath),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const logStream = fs.createWriteStream(logPath, { flags: "a" });
        
        child.stdout.on("data", (chunk) => {
          logStream.write(chunk);
        });
        
        child.stderr.on("data", (chunk) => {
          logStream.write(chunk);
        });

        child.on("spawn", async () => {
          const nextRuntime = await this.store.saveRuntime(instance.id, {
            status: "running",
            pid: child.pid,
            lastExitCode: null,
            lastStartedAt: new Date().toISOString(),
            lastError: "",
          });
          this.processMap.set(instance.id, child);
          this.logger.info(`实例 ${instance.name} 已启动，PID=${child.pid}`);
          resolve(nextRuntime);
        });

        child.on("error", async (error) => {
          const errMsg = `启动进程失败: ${error.message}`;
          await this.store.appendLog(instance.id, this.buildLogLine("ERROR", errMsg));
          await this.store.saveRuntime(instance.id, {
            status: "error",
            pid: null,
            lastError: errMsg,
          });
          this.processMap.delete(instance.id);
          logStream.end();
          
          // 如果还没有 resolve，说明是在 spawn 阶段出错
          reject(new Error(errMsg));
        });

        child.on("close", async (code, signal) => {
          const msg = `进程结束，退出码=${code}, 信号=${signal || "none"}`;
          await this.store.appendLog(instance.id, this.buildLogLine("INFO", msg));
          
          await this.store.saveRuntime(instance.id, {
            status: code === 0 ? "stopped" : "error",
            pid: null,
            lastExitCode: code,
            lastError: code === 0 ? "" : msg,
          });
          
          this.processMap.delete(instance.id);
          logStream.end();
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(instanceId) {
    const runtime = await this.store.getRuntime(instanceId);
    if (!runtime.pid || !this.checkPid(runtime.pid)) {
      return this.store.saveRuntime(instanceId, {
        ...runtime,
        status: "stopped",
        pid: null,
      });
    }

    const child = this.processMap.get(instanceId);
    await this.store.appendLog(instanceId, this.buildLogLine("INFO", "停止实例..."));
    await this.store.saveRuntime(instanceId, {
      ...runtime,
      status: "stopping",
    });

    try {
      if (child) {
        child.kill("SIGTERM");
      } else {
        process.kill(runtime.pid, "SIGTERM");
      }
    } catch (error) {
      await this.store.appendLog(
        instanceId,
        this.buildLogLine("ERROR", `停止指令发送失败：${error.message}`)
      );
      throw error;
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!this.checkPid(runtime.pid)) {
        return this.store.getRuntime(instanceId);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (runtime.pid && this.checkPid(runtime.pid)) {
      try {
        process.kill(runtime.pid, "SIGKILL");
        await this.store.appendLog(instanceId, this.buildLogLine("WARN", "已强制结束进程 (SIGKILL)"));
      } catch (error) {
        this.logger.warn(`强制停止实例失败：${error.message}`);
      }
    }

    return this.store.getRuntime(instanceId);
  }

  async restart(instance) {
    await this.stop(instance.id);
    return this.start(instance);
  }

  async stopAll() {
    const instances = await this.store.listInstances();
    for (const instance of instances) {
      const runtime = await this.store.getRuntime(instance.id);
      if (runtime.pid && this.checkPid(runtime.pid)) {
        await this.stop(instance.id);
      }
    }
  }

  checkPid(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  buildLogLine(level, message) {
    return `[${new Date().toISOString()}] [${level}] ${message}`;
  }
}

module.exports = {
  ProcessManager,
};
