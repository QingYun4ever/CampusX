import { get, type Row } from '../db.ts';

export const USER_COLS = `u.id, u.username, u.display_name, u.bio, u.avatar, u.banner, u.class_name, u.grad_year, u.role, u.verified, u.verified_note, u.created_at`;

export function userPublic(r: Row) {
  return {
    id: r.id as number,
    username: r.username as string,
    displayName: r.display_name as string,
    bio: r.bio as string,
    avatar: (r.avatar as string | null) ?? null,
    banner: (r.banner as string | null) ?? null,
    className: r.class_name as string,
    gradYear: (r.grad_year as number | null) ?? null,
    role: r.role as 'user' | 'admin',
    verified: !!r.verified,
    verifiedNote: (r.verified_note as string) ?? '',
    createdAt: r.created_at as number,
  };
}

export function userById(id: number) {
  const r = get(`SELECT ${USER_COLS} FROM users u WHERE u.id = $id`, { id });
  return r ? userPublic(r) : undefined;
}
