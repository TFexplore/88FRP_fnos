function safeJsonParse(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallbackValue;
  }
}

function validateConfigText(configText) {
  const text = String(configText || "").trim();
  const errors = [];
  const warnings = [];

  if (!text) {
    errors.push("配置内容不能为空。");
  }

  if (text.length > 0 && text.length < 10) {
    errors.push("配置内容过短，请确认是否粘贴完整。");
  }

  if (
    text &&
    !/server(addr|_addr|Addr)|bindPort|\[common\]|\[.+\]/i.test(text)
  ) {
    warnings.push("未检测到明显的 frpc 配置特征，请确认内容格式。");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

async function fetchRemoteConfig(input) {
  const secretKey = String(input.secretKey || "").trim();
  const remoteUrl = `https://api.88frp.com/frp/config?secret=${encodeURIComponent(secretKey)}`;

  console.log(`[ConfigService] Fetching from: ${remoteUrl}`);

  try {
    const response = await fetch(remoteUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain, */*",
      },
    });

    if (!response.ok) {
      throw new Error(`远程请求失败：${response.status} ${response.statusText}`);
    }

    const responseText = await response.text();
    let configText = responseText;

    // 尝试解析 JSON，如果返回的是 JSON 且包含 data 字段，则提取
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const parsed = safeJsonParse(responseText, null);
      if (parsed && parsed.data && typeof parsed.data === 'string') {
        configText = parsed.data;
      } else if (parsed && parsed.config && typeof parsed.config === 'string') {
        configText = parsed.config;
      }
    }

    const validation = validateConfigText(configText);
    return {
      configText,
      validation,
    };
  } catch (error) {
    console.error(`[ConfigService] Error: ${error.message}`);
    throw error;
  }
}

module.exports = {
  fetchRemoteConfig,
  safeJsonParse,
  validateConfigText,
};
