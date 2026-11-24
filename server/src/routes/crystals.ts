import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../db.ts';
import { buyDecoration, claimTask, crystalCheckin, CRYSTAL, history, tipPost, wallet } from '../crystals.ts';
import { boostPost, boostStatus, endBoosts } from '../boosts.ts';
import { assertCanInteract } from '../serialize.ts';
import { resolveTarget } from './posts.ts';
import { cursorNum, me, parse } from '../util.ts';
import { createMyInvite, myInvites } from '../invites.ts';

export async function crystalRoutes(app: FastifyInstance) {
  app.get('/me/crystals', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return wallet(me(req).id);
  });

  app.get('/me/crystals/log', async (req) => {
    const user = me(req);
    const before = cursorNum((req.query as { cursor?: string }).cursor);
    const items = history(user.id, before);
    return { items, nextCursor: items.length >= 30 ? String(items[items.length - 1].id) : null };
  });

  app.post('/me/crystals/checkin', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const res = tx(() => crystalCheckin(user.id));
    return { gained: res?.gained ?? 0, already: !res, wallet: wallet(user.id) };
  });

  app.post('/me/crystals/tasks/:id/claim', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const gained = tx(() => claimTask(user.id, (req.params as { id: string }).id));
    return { gained, wallet: wallet(user.id) };
  });

  /* ---------- 邀请同学 ---------- */
  app.get('/me/invites', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return myInvites(me(req).id);
  });

  app.post('/me/invites', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    tx(() => createMyInvite(user.id));
    return myInvites(user.id);
  });

  app.post('/me/decorations/:id/buy', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const spent = tx(() => buyDecoration(user.id, (req.params as { id: string }).id));
    return { spent, wallet: wallet(user.id) };
  });

  const tipSchema = z.object({ amount: z.number().int() });
  app.post('/posts/:id/tip', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const { amount } = parse(tipSchema, req.body);
    return tx(() => {
      const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
      assertCanInteract(user.id, target.author_id);
      return tipPost(user.id, target, amount);
    });
  });

  /* ---------- 推流 ---------- */
  app.get('/posts/:id/boost', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = me(req);
    const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
    tx(() => endBoosts(true));
    return boostStatus(target.id, user.id);
  });

  app.post('/posts/:id/boost', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = me(req);
    const { amount } = parse(tipSchema, req.body);
    return tx(() => {
      const target = resolveTarget(Number((req.params as { id: string }).id), user.id);
      assertCanInteract(user.id, target.author_id);
      const reach = boostPost(user.id, target.id, amount);
      return { reach, status: boostStatus(target.id, user.id), wallet: wallet(user.id) };
    });
  });

  app.get('/crystals/rules', async () => CRYSTAL);
}
