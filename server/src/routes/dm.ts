/**
 * 私信（Telegram 式一对一聊天）。
 * 前端轮询 /dm/with/:username?after=<最后一条 id> 拿新消息，同时返回对方读到了哪一条（显示 ✓✓）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.ts';
import { all, get, now, run, tx, type Row } from '../db.ts';
import { hasImageSignature, imageTypes, readUploadedImage, type UploadedImage } from '../image-upload.ts';
import { assertCanInteract, blockState } from '../serialize.ts';
import { HttpError, me, parse } from '../util.ts';
import { USER_COLS, userPublic } from './users-common.ts';

const PAGE = 50;
const MAX_LEN = 2000;
const MAX_IMAGES = 4;
const dmUploads = path.join(config.dataDir, 'dm-uploads');
const tooLong = `一条消息最多 ${MAX_LEN} 字`;
const contentSchema = z.string().trim().max(MAX_LEN, tooLong);
const textMessageSchema = z.object({ content: z.string().trim().min(1, '消息不能为空').max(MAX_LEN, tooLong) });

const imageUrl = (id: number, position: number) => `/dm/messages/${id}/images/${position}`;
const imageMissing = () => new HttpError(404, '图片不存在');

function imagesFor(ids: number[]) {
  const images = new Map<number, string[]>();
  if (!ids.length) return images;
  const rows = all<{ message_id: number; position: number }>(
    `SELECT message_id, position FROM dm_message_images
     WHERE message_id IN (SELECT value FROM json_each($ids)) ORDER BY message_id, position`,
    { ids: JSON.stringify(ids) },
  );
  for (const { message_id, position } of rows) {
    const url = imageUrl(message_id, position);
    const urls = images.get(message_id);
    if (urls) urls.push(url);
    else images.set(message_id, [url]);
  }
  return images;
}

async function readImageMessage(req: FastifyRequest) {
  let content: string | undefined;
  let invalid: HttpError | undefined;
  const images: UploadedImage[] = [];
  try {
    for await (const part of req.parts({
      limits: { files: MAX_IMAGES, fields: 1, parts: MAX_IMAGES + 1, fileSize: config.maxUploadBytes, fieldSize: MAX_LEN * 4 },
    })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'images') invalid ??= new HttpError(400, '图片字段必须是 images');
        if (invalid) part.file.resume();
        else {
          try {
            images.push(await readUploadedImage(part));
          } catch (err) {
            if (!(err instanceof HttpError) || err.status !== 400) throw err;
            invalid = err;
          }
        }
      } else if (part.fieldname !== 'content' || typeof part.value !== 'string' || part.fieldnameTruncated) {
        invalid ??= new HttpError(400, '文本字段必须是 content');
      } else if (part.valueTruncated) {
        invalid ??= new HttpError(400, tooLong);
      } else {
        content = part.value;
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, '文件太大了');
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
      throw new HttpError(400, `一条消息最多 ${MAX_IMAGES} 张图片`);
    }
    throw new HttpError(400, '图片表单无效');
  }
  if (invalid) throw invalid;
  if (!images.length) throw new HttpError(400, '没有收到图片');
  return { content: parse(contentSchema, content ?? ''), images };
}

function storeMessage(senderId: number, recipientId: number, content: string, filenames: string[]) {
  const createdAt = now();
  const insert = () => {
    const { lastId } = run(
      'INSERT INTO dm_messages (sender_id, recipient_id, content, created_at) VALUES ($s, $r, $c, $t)',
      { s: senderId, r: recipientId, c: content, t: createdAt },
    );
    filenames.forEach((filename, position) => {
      run('INSERT INTO dm_message_images (message_id, position, filename) VALUES ($id, $position, $filename)', {
        id: lastId, position, filename,
      });
    });
    return {
      id: lastId, senderId, content, deleted: false, createdAt,
      images: filenames.map((_, position) => imageUrl(lastId, position)),
    };
  };
  return filenames.length ? tx(insert) : insert();
}

function visibleImage(id: number, position: number, userId: number) {
  return get<{ filename: string }>(
    `SELECT i.filename FROM dm_message_images i JOIN dm_messages m ON m.id = i.message_id
     WHERE i.message_id = $id AND i.position = $position AND m.deleted = 0
       AND (m.sender_id = $userId OR m.recipient_id = $userId)`,
    { id, position, userId },
  );
}

function imageExt(filename: string) {
  const match = /^[\w-]{16}\.(jpg|png|webp|gif)$/.exec(filename);
  return match?.[1] as keyof typeof imageTypes | undefined;
}

function removeImage(filename: string) {
  if (!imageExt(filename)) throw new Error('私信图片文件名无效');
  return fs.rm(path.join(dmUploads, filename), { force: true });
}

function message(r: Row, images: string[]) {
  const deleted = !!r.deleted;
  return {
    id: r.id as number,
    senderId: r.sender_id as number,
    content: deleted ? '' : (r.content as string),
    deleted,
    createdAt: r.created_at as number,
    images: deleted ? [] : images,
  };
}

function peerOf(username: string, meId: number) {
  const r = get(`SELECT ${USER_COLS}, u.last_seen_at FROM users u WHERE u.username = $n`, { n: username });
  if (!r) throw new HttpError(404, '没有这个用户');
  if (r.id === meId) throw new HttpError(400, '不能给自己发私信');
  return { ...userPublic(r), lastSeenAt: (r.last_seen_at as number | null) ?? null };
}

/** 对方已经读到我发的哪一条 */
const peerReadUpTo = (meId: number, peerId: number) =>
  get<{ id: number | null }>(
    'SELECT MAX(id) AS id FROM dm_messages WHERE sender_id = $me AND recipient_id = $p AND read_at IS NOT NULL',
    { me: meId, p: peerId },
  )?.id ?? 0;

export async function dmRoutes(app: FastifyInstance) {
  /** 聊天列表：每个聊天对象的最后一条消息和未读数 */
  app.get('/dm/conversations', async (req) => {
    const user = me(req);
    const rows = all(
      `WITH mine AS (
         SELECT CASE WHEN sender_id = $me THEN recipient_id ELSE sender_id END AS peer, id,
                (recipient_id = $me AND read_at IS NULL) AS unread
         FROM dm_messages WHERE sender_id = $me OR recipient_id = $me
       ), conv AS (
         SELECT peer, MAX(id) AS last_id, SUM(unread) AS unread FROM mine GROUP BY peer
       )
       SELECT conv.unread, conv.last_id, m.sender_id, m.content, m.deleted, m.created_at AS m_created_at, m.read_at,
              ${USER_COLS}, u.last_seen_at
       FROM conv JOIN dm_messages m ON m.id = conv.last_id JOIN users u ON u.id = conv.peer
       ORDER BY conv.last_id DESC LIMIT 200`,
      { me: user.id },
    );
    const images = imagesFor(rows.filter((r) => !r.deleted).map((r) => r.last_id as number));
    return rows.map((r) => ({
      peer: { ...userPublic(r), lastSeenAt: (r.last_seen_at as number | null) ?? null },
      unread: r.unread as number,
      last: {
        id: r.last_id as number,
        senderId: r.sender_id as number,
        content: r.deleted ? '' : (r.content as string),
        deleted: !!r.deleted,
        createdAt: r.m_created_at as number,
        read: r.read_at != null,
        images: images.get(r.last_id) ?? [],
      },
    }));
  });

  app.get('/dm/unread-count', async (req) => {
    const r = get<{ n: number }>('SELECT COUNT(*) AS n FROM dm_messages WHERE recipient_id = $me AND read_at IS NULL', {
      me: me(req).id,
    });
    return { count: r?.n ?? 0 };
  });

  /**
   * 和某人的消息。
   * - 不带参数：最近 50 条
   * - before=<id>：更早的 50 条（往上翻）
   * - after=<id>：这条之后的新消息（轮询）
   * 都按 id 正序返回
   */
  app.get('/dm/with/:username', async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    const q = req.query as { before?: string; after?: string };
    const before = Number(q.before) || 0;
    const after = Number(q.after) || 0;
    const pair = `((sender_id = $me AND recipient_id = $p) OR (sender_id = $p AND recipient_id = $me))`;
    const rows = after
      ? all(`SELECT * FROM dm_messages WHERE ${pair} AND id > $after ORDER BY id ASC LIMIT 200`, { me: user.id, p: peer.id, after })
      : all(`SELECT * FROM dm_messages WHERE ${pair} AND ($before = 0 OR id < $before) ORDER BY id DESC LIMIT $limit`, {
          me: user.id,
          p: peer.id,
          before,
          limit: PAGE,
        }).reverse();
    const images = imagesFor(rows.filter((r) => !r.deleted).map((r) => r.id as number));
    // 轮询时也要知道对方删掉了哪些消息
    const deletedIds = after
      ? all<{ id: number }>(`SELECT id FROM dm_messages WHERE ${pair} AND deleted = 1 AND id <= $after ORDER BY id DESC LIMIT 100`, {
          me: user.id,
          p: peer.id,
          after,
        }).map((r) => r.id)
      : [];
    return {
      peer,
      messages: rows.map((r) => message(r, images.get(r.id) ?? [])),
      hasMore: !after && rows.length >= PAGE,
      peerReadUpTo: peerReadUpTo(user.id, peer.id),
      deletedIds,
      block: blockState(user.id, peer.id),
    };
  });

  app.post('/dm/with/:username', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    assertCanInteract(user.id, peer.id);
    if (!req.isMultipart()) {
      const { content } = parse(textMessageSchema, req.body);
      return storeMessage(user.id, peer.id, content, []);
    }

    const { content, images } = await readImageMessage(req);
    const filenames: string[] = [];
    try {
      await fs.mkdir(dmUploads, { recursive: true, mode: 0o700 });
      for (const { buffer, ext } of images) {
        const filename = `${randomBytes(12).toString('base64url')}.${ext}`;
        const handle = await fs.open(path.join(dmUploads, filename), 'wx', 0o600);
        filenames.push(filename);
        try {
          await handle.writeFile(buffer);
        } finally {
          await handle.close();
        }
      }
      return storeMessage(user.id, peer.id, content, filenames);
    } catch (err) {
      const cleanup = await Promise.allSettled(filenames.map(removeImage));
      for (const result of cleanup) {
        if (result.status === 'rejected') req.log.error(result.reason, '清理私信图片失败');
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string; position: string } }>('/dm/messages/:id/images/:position', {
    onRequest: async (req, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!req.user) throw imageMissing();
    },
  }, async (req, reply) => {
    const user = me(req);
    if (!/^[1-9]\d*$/.test(req.params.id) || !/^\d$/.test(req.params.position)) throw imageMissing();
    const id = Number(req.params.id);
    const position = Number(req.params.position);
    if (!Number.isSafeInteger(id) || position >= MAX_IMAGES) throw imageMissing();
    const image = visibleImage(id, position, user.id);
    const ext = image && imageExt(image.filename);
    if (!image || !ext) throw imageMissing();
    const buffer = await fs.readFile(path.join(dmUploads, image.filename)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw imageMissing();
      throw err;
    });
    // 读盘期间消息可能已撤回，返回前再次确认访问权限。
    if (!hasImageSignature(buffer, ext) || visibleImage(id, position, user.id)?.filename !== image.filename) {
      throw imageMissing();
    }
    return reply.type(imageTypes[ext]).send(buffer);
  });

  /** 打开聊天时把对方发来的标为已读 */
  app.post('/dm/with/:username/read', async (req) => {
    const user = me(req);
    const peer = peerOf((req.params as { username: string }).username, user.id);
    run('UPDATE dm_messages SET read_at = $t WHERE sender_id = $p AND recipient_id = $me AND read_at IS NULL', {
      t: now(),
      p: peer.id,
      me: user.id,
    });
    return { ok: true };
  });

  /** 撤回自己的消息（双方都看不到内容） */
  app.delete('/dm/messages/:id', async (req) => {
    const user = me(req);
    const id = Number((req.params as { id: string }).id);
    const r = run("UPDATE dm_messages SET deleted = 1, content = '' WHERE id = $id AND sender_id = $me", { id, me: user.id });
    if (!r.changes) throw new HttpError(404, '消息不存在');
    const images = all<{ filename: string }>('SELECT filename FROM dm_message_images WHERE message_id = $id', { id });
    if (images.length) {
      await Promise.all(images.map(({ filename }) => removeImage(filename)));
      run('DELETE FROM dm_message_images WHERE message_id = $id', { id });
    }
    return { ok: true };
  });
}
