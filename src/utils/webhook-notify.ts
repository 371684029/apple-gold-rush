// Webhook 通知 — 企业微信 / 钉钉 / 通用 JSON

export type WebhookType = 'generic' | 'dingtalk' | 'wecom';

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface NotifyMessage {
  title: string;
  body: string;
  level?: NotifyLevel;
}

/** 构造请求体 */
export function buildWebhookBody(type: WebhookType, msg: NotifyMessage): unknown {
  const levelEmoji = msg.level === 'error' ? '🔴' : msg.level === 'warn' ? '🟡' : '🟢';
  const text = `${levelEmoji} **${msg.title}**\n\n${msg.body}`;

  switch (type) {
    case 'dingtalk':
      return {
        msgtype: 'markdown',
        markdown: { title: msg.title, text },
      };
    case 'wecom':
      return {
        msgtype: 'markdown',
        markdown: { content: text },
      };
    default:
      return {
        title: msg.title,
        text: msg.body,
        level: msg.level ?? 'info',
        source: 'goldrush',
        timestamp: new Date().toISOString(),
      };
  }
}

/** 发送 webhook（未配置 URL 时静默跳过） */
export async function sendWebhook(
  url: string,
  type: WebhookType,
  msg: NotifyMessage,
): Promise<{ sent: boolean; error?: string }> {
  if (!url || !url.startsWith('http')) {
    return { sent: false, error: 'webhook_url_not_configured' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(type, msg)),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
