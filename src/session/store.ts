import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { sessionsDir } from '../config/paths.js';

export interface SessionMeta {
  id: string;
  root: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** First user message, used as the label in `kdg --resume`. */
  title: string;
  messageCount: number;
}

interface MetaRecord {
  kind: 'meta';
  meta: SessionMeta;
}

interface MessagesRecord {
  kind: 'messages';
  at: string;
  messages: ModelMessage[];
}

type Record_ = MetaRecord | MessagesRecord;

/**
 * Append-only JSONL per session.
 *
 * The full, *uncompacted* history is written here. Compaction only shrinks what
 * we send to the model — the transcript on disk stays complete so `--resume`
 * and post-hoc debugging see everything that actually happened.
 */
export class SessionStore {
  private constructor(
    private readonly file: string,
    private meta: SessionMeta,
    private readonly fullHistory: ModelMessage[],
  ) {}

  get id(): string {
    return this.meta.id;
  }

  get messages(): ModelMessage[] {
    return this.fullHistory;
  }

  static async create(params: {
    root: string;
    provider: string;
    model: string;
  }): Promise<SessionStore> {
    const id = randomUUID();
    const dir = sessionsDir();
    await fs.mkdir(dir, { recursive: true });
    const now = new Date().toISOString();

    const meta: SessionMeta = {
      id,
      root: params.root,
      provider: params.provider,
      model: params.model,
      createdAt: now,
      updatedAt: now,
      title: '',
      messageCount: 0,
    };

    const store = new SessionStore(path.join(dir, `${id}.jsonl`), meta, []);
    await store.append({ kind: 'meta', meta });
    return store;
  }

  static async open(id: string): Promise<SessionStore> {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    const raw = await fs.readFile(file, 'utf8');

    let meta: SessionMeta | undefined;
    let messages: ModelMessage[] = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let record: Record_;
      try {
        record = JSON.parse(line) as Record_;
      } catch {
        continue; // a partial trailing write shouldn't make the session unopenable
      }
      if (record.kind === 'meta') meta = record.meta;
      else if (record.kind === 'messages') messages = record.messages;
    }

    if (!meta) throw new Error(`Session ${id} has no metadata record.`);
    return new SessionStore(file, meta, messages);
  }

  /** Newest first. Optionally filtered to one workspace. */
  static async list(root?: string): Promise<SessionMeta[]> {
    const dir = sessionsDir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const metas = await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl'))
        .map(async (name) => {
          try {
            const store = await SessionStore.open(name.replace(/\.jsonl$/, ''));
            return store.meta;
          } catch {
            return undefined;
          }
        }),
    );

    return metas
      .filter((m): m is SessionMeta => m !== undefined)
      .filter((m) => (root ? m.root === root : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  static async latest(root: string): Promise<SessionStore | undefined> {
    const [newest] = await SessionStore.list(root);
    return newest ? SessionStore.open(newest.id) : undefined;
  }

  async save(messages: ModelMessage[]): Promise<void> {
    this.fullHistory.length = 0;
    this.fullHistory.push(...messages);

    if (!this.meta.title) {
      const firstUser = messages.find((m) => m.role === 'user');
      if (firstUser) this.meta.title = summarizeContent(firstUser.content).slice(0, 80);
    }
    this.meta.updatedAt = new Date().toISOString();
    this.meta.messageCount = messages.length;

    await this.append({ kind: 'meta', meta: this.meta });
    await this.append({ kind: 'messages', at: this.meta.updatedAt, messages });
  }

  private async append(record: Record_): Promise<void> {
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

function summarizeContent(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}
