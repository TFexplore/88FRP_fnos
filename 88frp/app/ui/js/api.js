// API 请求封装
const API = (() => {
  async function request(url, options = {}) {
    try {
      const response = await fetch(url, {
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
    stopInstance: (id) => request(`/api/instances/${id}/stop`, {
      method: "POST",
    }),
    getLogs: (id) => request(`/api/instances/${id}/logs`),
  };
})();
