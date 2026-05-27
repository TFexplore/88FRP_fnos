// API 请求封装
const API = (() => {
  function resolveApiBase() {
    const pathname = window.location.pathname || "/";
    const cgiIndex = pathname.indexOf("/index.cgi");
    if (cgiIndex >= 0) {
      // 确保返回的是 /cgi/ThirdParty/88frp/api.cgi 这样的完整路径
      return pathname.slice(0, cgiIndex) + "/api.cgi";
    }

    return new URL(".", window.location.href).pathname.replace(/\/$/, "");
  }

  const apiBase = resolveApiBase();

  async function request(url, options = {}) {
    try {
      const response = await fetch(`${apiBase}${url}`, {
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

      const payload = await response.json();
      return payload;
    } catch (error) {
      return {
        success: false,
        message: error.message || "网络请求异常"
      };
    }
  }

  return {
    getHealth: () => request("/api/health"),
    getInstances: () => request("/api/instances"),
    createInstance: (payload) => request("/api/instances", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    getInstance: (id) => request(`/api/instances/${id}`),
    updateInstance: (id, payload) => request(`/api/instances/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
    deleteInstance: (id) => request(`/api/instances/${id}`, {
      method: "DELETE",
    }),
    getConfig: (id) => request(`/api/instances/${id}/config`),
    saveConfig: (id, configText) => request(`/api/instances/${id}/config`, {
      method: "PUT",
      body: JSON.stringify({ configText }),
    }),
    fetchRemoteConfig: (id, payload) => request(`/api/instances/${id}/fetch-config`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    startInstance: (id) => request(`/api/instances/${id}/start`, {
      method: "POST",
    }),
    restartInstance: (id) => request(`/api/instances/${id}/restart`, {
      method: "POST",
    }),
    stopInstance: (id) => request(`/api/instances/${id}/stop`, {
      method: "POST",
    }),
    getLogs: (id) => request(`/api/instances/${id}/logs`),
  };
})();
