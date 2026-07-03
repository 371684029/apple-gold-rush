import { describe, it, expect } from 'vitest';
import { buildWebhookBody, sendWebhook } from '../src/utils/webhook-notify';

describe('buildWebhookBody', () => {
  it('generic 含 source 与时间戳', () => {
    const body = buildWebhookBody('generic', { title: '测试', body: '内容', level: 'warn' }) as Record<string, unknown>;
    expect(body.source).toBe('goldrush');
    expect(body.level).toBe('warn');
    expect(body.title).toBe('测试');
  });

  it('dingtalk 使用 markdown 结构', () => {
    const body = buildWebhookBody('dingtalk', { title: 'T', body: 'B' }) as { msgtype: string; markdown: { text: string } };
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.text).toContain('T');
  });

  it('wecom 使用 markdown content', () => {
    const body = buildWebhookBody('wecom', { title: 'T', body: 'B' }) as { markdown: { content: string } };
    expect(body.markdown.content).toContain('B');
  });
});

describe('sendWebhook', () => {
  it('未配置 URL 时跳过', async () => {
    const r = await sendWebhook('', 'generic', { title: 'x', body: 'y' });
    expect(r.sent).toBe(false);
    expect(r.error).toBe('webhook_url_not_configured');
  });
});
