import type { MessageNode, StreamEvent } from '../types';

function getCurrentLocale() {
  try {
    return window.localStorage.getItem('murphy-cookbook.locale.v1') === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function applyStreamEvent(nodes: MessageNode[], event: StreamEvent): MessageNode[] {
  if (event.type === 'text-delta' || event.type === 'markdown-delta') {
    const nodeType: 'text' | 'markdown' = event.type === 'text-delta' ? 'text' : 'markdown';
    const existing = nodes.find((node) => node.id === event.id && node.type === nodeType);
    if (existing && (existing.type === 'text' || existing.type === 'markdown')) {
      return nodes.map((node) =>
        node.id === event.id && node.type === nodeType
          ? { ...node, content: node.content + event.delta }
          : node,
      );
    }

    return [
      ...nodes,
      {
        id: event.id,
        type: nodeType,
        content: event.delta,
      },
    ];
  }

  if (event.type === 'code-start') {
    return [
      ...nodes.filter((node) => node.id !== event.id),
      { id: event.id, type: 'code' as const, language: event.language, content: '' },
    ];
  }

  if (event.type === 'code-delta') {
    return nodes.map((node) =>
      node.id === event.id && node.type === 'code'
        ? { ...node, content: node.content + event.delta }
        : node,
    );
  }

  if (event.type === 'card') {
    return [
      ...nodes.filter((node) => node.id !== event.id),
      { id: event.id, type: 'card' as const, cardType: event.cardType, props: event.props },
    ];
  }

  if (event.type === 'mermaid') {
    return [
      ...nodes.filter((node) => node.id !== event.id),
      { id: event.id, type: 'mermaid' as const, content: event.content },
    ];
  }

  if (event.type === 'error') {
    return nodes;
  }

  return nodes;
}

export function parseSseChunk(buffer: string) {
  const events: StreamEvent[] = [];
  const blocks = buffer.split(/\n\n/);
  const rest = blocks.pop() ?? '';

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();

    if (!data) {
      continue;
    }

    try {
      events.push(JSON.parse(data) as StreamEvent);
    } catch {
      events.push({
        type: 'error',
        message: getCurrentLocale() === 'en' ? 'Failed to parse the streaming response.' : '流式消息解析失败。',
      });
    }
  }

  return { events, rest };
}
