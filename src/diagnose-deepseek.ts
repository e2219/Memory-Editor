import { DeepSeekGateway } from "./deepseek.ts";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const apiUrl = process.env.DEEPSEEK_API_URL ??
  "https://api.deepseek.com/chat/completions";

if (!apiKey) {
  console.error("✗ 当前进程没有收到 DEEPSEEK_API_KEY。请在同一个终端中设置并 export 后重试。");
  process.exitCode = 1;
} else {
  console.log("✓ 已检测到 DEEPSEEK_API_KEY（不会显示其内容）");
  console.log(`  模型：deepseek-chat`);
  console.log(`  接口：${apiUrl}`);

  const gateway = new DeepSeekGateway({
    apiKey,
    model: "deepseek-chat",
    apiUrl,
  });

  try {
    await gateway.probe();
    console.log("✓ DeepSeek 请求成功，JSON 输出可解析。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✗ DeepSeek 诊断失败：${message}`);
    if (message.includes("deepseek_http_401")) {
      console.error("  可能原因：Key 无效、复制不完整或未正确导出。");
    } else if (message.includes("deepseek_http_402")) {
      console.error("  可能原因：账户余额或可用额度不足。");
    } else if (message.includes("deepseek_http_429")) {
      console.error("  可能原因：请求过于频繁或触发速率限制。");
    } else if (message.includes("fetch failed") || message.includes("TimeoutError")) {
      console.error("  可能原因：网络无法访问 DeepSeek，或请求超时。");
    } else if (message.includes("probe_invalid_json") || message.includes("JSON")) {
      console.error("  API 已响应，但没有返回约定的 JSON。");
    }
    process.exitCode = 1;
  }
}
